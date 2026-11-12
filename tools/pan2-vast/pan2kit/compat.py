"""Optional PyTorch SDPA attention for GPUs the pinned FlashAttention-4 kernels do not support.

The pinned FA4 build fails on consumer Blackwell (sm_120: its kernel needs more shared memory than
the card has). This module swaps the two attention entry points and the text encoder's backend at
runtime, from the worker process, so the pinned PAN2 checkout stays clean and hash-verified.
It is a different numerical path from FA4, so a run using it is a different workload: the backend is
bound into the plan's case identity and recorded in worker.json, and must never be paired with an
FA4 run as the same case. It does not change the quack GEMMs or the Triton kernels.
"""
import importlib
import sys
import torch
import torch.nn.functional as F


def _sdpa(q, k, v, scale, causal):
    """q [Lq,H,D], k/v [Lk,H,D] -> [Lq,H,D]; one sequence, no mask."""
    if causal and q.shape[0] != k.shape[0]:
        raise NotImplementedError('causal attention with unequal q/k lengths is not supported by the SDPA path')
    out = F.scaled_dot_product_attention(q.transpose(0, 1).unsqueeze(0), k.transpose(0, 1).unsqueeze(0),
                                         v.transpose(0, 1).unsqueeze(0), scale=scale, is_causal=causal)
    return out.squeeze(0).transpose(0, 1)


def padded_sdpa_attention(query, key, value, query_padding_mask=None, key_padding_mask=None, causal=False,
                          dropout_p=0.0, softmax_scale=None, deterministic=False):
    """Same contract as pan.utils.flash_attention.padded_flash_attention: [B,S,H,D] in and out,
    padded query rows returned as zeros."""
    if dropout_p != 0.0:
        raise ValueError('The SDPA inference path does not support dropout')
    if query.ndim != 4 or key.ndim != 4 or value.ndim != 4:
        raise ValueError('Q/KV must be [B, S, H, D] tensors.')
    if key.shape != value.shape:
        raise ValueError('Key/value shapes must match.')
    if query.shape[0] != key.shape[0] or query.shape[2:] != key.shape[2:]:
        raise ValueError('Query and key/value batch/head shapes must match.')
    masks = []
    for name, mask, tensor in (('query_padding_mask', query_padding_mask, query), ('key_padding_mask', key_padding_mask, key)):
        if mask is not None:
            if tuple(mask.shape) != tuple(tensor.shape[:2]):
                raise ValueError(f'{name} must have shape {tuple(tensor.shape[:2])}.')
            mask = mask.to(device=tensor.device, dtype=torch.bool)
        masks.append(mask)
    qm, km = masks
    if query.shape[1] == 0:
        return torch.empty_like(query)
    if all(m is None or bool(m.all()) for m in masks):
        out = F.scaled_dot_product_attention(query.transpose(1, 2), key.transpose(1, 2), value.transpose(1, 2),
                                             scale=softmax_scale, is_causal=causal)
        return out.transpose(1, 2).contiguous()
    out = torch.zeros_like(query)
    for b in range(query.shape[0]):
        qb = query[b] if qm is None else query[b][qm[b]]
        kb = key[b] if km is None else key[b][km[b]]
        vb = value[b] if km is None else value[b][km[b]]
        if qb.shape[0] == 0 or kb.shape[0] == 0:
            continue
        ob = _sdpa(qb, kb, vb, softmax_scale, causal)
        if qm is None:
            out[b] = ob
        else:
            out[b][qm[b]] = ob
    return out


def varlen_sdpa(q, k, v, cu_seqlens_q, cu_seqlens_k, max_seqlen_q, max_seqlen_k, seqused_q=None, seqused_k=None,
                causal=False, dropout_p=0.0, softmax_scale=None, deterministic=False):
    """Same contract as pan.utils.flash_attention.flash_attn_varlen: packed [nnz,H,D] in, [nnz, H*D] out.
    Rows outside a sequence's used length are zeros."""
    if dropout_p != 0.0:
        raise ValueError('The SDPA inference path does not support dropout')
    cq = [int(x) for x in cu_seqlens_q.tolist()]
    ck = [int(x) for x in cu_seqlens_k.tolist()]
    uq = None if seqused_q is None else [int(x) for x in seqused_q.tolist()]
    uk = None if seqused_k is None else [int(x) for x in seqused_k.tolist()]
    out = torch.zeros((q.shape[0], q.shape[1], v.shape[-1]), dtype=q.dtype, device=q.device)
    for i in range(len(cq) - 1):
        lq = (cq[i + 1] - cq[i]) if uq is None else min(uq[i], cq[i + 1] - cq[i])
        lk = (ck[i + 1] - ck[i]) if uk is None else min(uk[i], ck[i + 1] - ck[i])
        if lq <= 0 or lk <= 0:
            continue
        out[cq[i]:cq[i] + lq] = _sdpa(q[cq[i]:cq[i] + lq], k[ck[i]:ck[i] + lk], v[ck[i]:ck[i] + lk], softmax_scale, causal)
    return out.flatten(1)


class SdpaState:
    def __init__(self, originals):
        self.originals = originals

    def verify(self):
        """Fail loudly if any pan module still holds an FA4 entry point, or the main consumer was missed."""
        stale = []
        for name, mod in list(sys.modules.items()):
            if not name.startswith('pan') or mod is None:
                continue
            for attr, original in self.originals.items():
                if getattr(mod, attr, None) is original:
                    stale.append(f'{name}.{attr}')
        if stale:
            raise RuntimeError('FlashAttention-4 entry points still bound: ' + ', '.join(stale))
        consumer = sys.modules.get('pan.models.transformers.modules.attention')
        if consumer is None or getattr(consumer, 'padded_flash_attention', None) is not padded_sdpa_attention:
            raise RuntimeError('The DiT attention module is not using the SDPA path')


def install_sdpa():
    """Call before importing the PAN2 generate module. Returns a state whose verify() must pass afterwards."""
    fa = importlib.import_module('pan.utils.flash_attention')
    originals = {'padded_flash_attention': fa.padded_flash_attention, 'flash_attn_varlen': fa.flash_attn_varlen}
    fa.padded_flash_attention = padded_sdpa_attention
    fa.flash_attn_varlen = varlen_sdpa
    te = importlib.import_module('pan.models.text_encoders')
    original_load = te.load_qwen_text_encoder

    def load_with_sdpa(*args, **kwargs):
        kwargs['attn_implementation'] = 'sdpa'
        return original_load(*args[:3], **kwargs) if len(args) > 3 else original_load(*args, **kwargs)
    te.load_qwen_text_encoder = load_with_sdpa
    replacements = {id(originals['padded_flash_attention']): padded_sdpa_attention,
                    id(originals['flash_attn_varlen']): varlen_sdpa}
    for name, mod in list(sys.modules.items()):
        if name.startswith('pan') and mod is not None and mod is not fa:
            for attr in originals:
                cur = getattr(mod, attr, None)
                if cur is not None and id(cur) in replacements:
                    setattr(mod, attr, replacements[id(cur)])
    return SdpaState(originals)
