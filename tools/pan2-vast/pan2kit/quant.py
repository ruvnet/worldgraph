"""Experimental raw-parameter storage quantization. Dense BF16 compute remains."""
import torch
from torch import nn
from torch.nn.utils import parametrize

class RowQuant(nn.Module):
    def __init__(self, bits, width, dtype):
        super().__init__()
        if bits not in (4, 8): raise ValueError('bits must be 4 or 8')
        self.bits, self.width, self.dtype = bits, width, dtype

    def right_inverse(self, value):
        if value.device.type != 'cpu': raise ValueError('Quantize on CPU before GPU residency')
        limit = 7 if self.bits == 4 else 127
        packed, scales = [], []
        rows = max(1, 4_000_000 // self.width)
        for start in range(0, value.shape[0], rows):
            v = value[start:start+rows].float()
            if not torch.isfinite(v).all(): raise ValueError('Nonfinite weights')
            scale = v.abs().amax(1, keepdim=True) / limit
            scale = torch.where(scale == 0, torch.ones_like(scale), scale)
            q = (v / scale).round().clamp(-limit, limit).to(torch.int8)
            if self.bits == 4:
                q = (q.to(torch.int16) + 8).to(torch.uint8)
                if self.width % 2: q = torch.nn.functional.pad(q, (0, 1), value=8)
                q = q[:, ::2] | (q[:, 1::2] << 4)
            packed.append(q); scales.append(scale)
        return torch.cat(packed), torch.cat(scales)

    def forward(self, q, scale):
        if self.bits == 4:
            q = torch.stack((q & 15, q >> 4), dim=-1).flatten(1)[:, :self.width]
            q = q.to(torch.int8) - 8
        return q.to(self.dtype) * scale.to(self.dtype)


def quantize(model, bits):
    if any(parametrize.is_parametrized(m) for m in model.modules()):
        raise ValueError('Model already contains parametrizations')
    model.requires_grad_(False)
    targets = [(name, m, p, v) for name, m in model.named_modules()
               for p, v in m.named_parameters(recurse=False)
               if name.startswith('blocks.') and v.ndim == 2 and v.is_floating_point()]
    if not targets: raise ValueError('No PAN2 block matrices found; architecture mismatch')
    before = sum(p.numel()*p.element_size() for p in model.parameters())
    records = []
    for name, module, key, value in targets:
        records.append({'name':name+'.'+key, 'shape':list(value.shape)})
        parametrize.register_parametrization(module, key, RowQuant(bits, value.shape[1], value.dtype))
    after = sum(p.numel()*p.element_size() for p in model.parameters())
    return {'bits':bits, 'compute':'dense BF16 reconstructed per access',
            'parameter_bytes_before':before, 'parameter_bytes_after':after, 'targets':records}

def save_quantized(model, path, bits):
    """Runtime state, not a native PAN2 checkpoint. Do not edit with WSP."""
    from safetensors.torch import save_file
    from pathlib import Path
    if Path(path).exists(): raise FileExistsError(path)
    save_file({k:v.detach().contiguous() for k,v in model.state_dict().items()},str(path),
              metadata={'schema':'pan2kit.quant-state/1','bits':str(bits)})

def load_quantized(model, path):
    """Reconstruct matching parametrizations, then strictly load packed state on CPU."""
    from safetensors import safe_open
    from safetensors.torch import load_file
    with safe_open(str(path),framework='pt',device='cpu') as f:
        meta=f.metadata() or {}
    if meta.get('schema')!='pan2kit.quant-state/1': raise ValueError('Unsupported quant state schema')
    bits=int(meta['bits']); report=quantize(model,bits)
    model.load_state_dict(load_file(str(path),device='cpu'),strict=True)
    return report
