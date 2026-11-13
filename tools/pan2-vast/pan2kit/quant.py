"""Experimental raw-parameter storage quantization. Dense BF16 compute remains."""
import json
import torch
from torch import nn
from torch.nn.utils import parametrize

class RowQuant(nn.Module):
    """Symmetric integer storage. `group` 0 = one scale per row; N = one scale per N columns of each row."""
    def __init__(self, bits, width, dtype, group=0):
        super().__init__()
        if bits not in (4, 8): raise ValueError('bits must be 4 or 8')
        if type(group) is not int or group < 0 or (group and group % 2): raise ValueError('group must be 0 or a positive even integer')
        self.bits, self.width, self.dtype = bits, width, dtype
        self.group = min(group, width) if group else width

    def right_inverse(self, value):
        g, ng = self.group, -(-self.width // self.group)
        if value.device.type == 'meta':  # structure only: shapes for a saved state to be assigned into
            cols = (self.width + 1)//2 if self.bits == 4 else self.width
            return (torch.empty((value.shape[0], cols), dtype=torch.uint8 if self.bits == 4 else torch.int8, device='meta'),
                    torch.empty((value.shape[0], ng), dtype=torch.float32, device='meta'))
        if value.device.type != 'cpu': raise ValueError('Quantize on CPU before GPU residency')
        limit = 7 if self.bits == 4 else 127
        packed = torch.empty((value.shape[0], (self.width + 1)//2 if self.bits == 4 else self.width), dtype=torch.uint8 if self.bits == 4 else torch.int8)
        scales = torch.empty((value.shape[0], ng), dtype=torch.float32)
        rows = max(1, 4_000_000 // self.width)
        for start in range(0, value.shape[0], rows):
            v = value[start:start+rows].float()
            if not torch.isfinite(v).all(): raise ValueError('Nonfinite weights')
            r = v.shape[0]
            vp = torch.nn.functional.pad(v, (0, ng*g - self.width)).view(r, ng, g)
            scale = vp.abs().amax(2, keepdim=True) / limit
            scale = torch.where(scale == 0, torch.ones_like(scale), scale)
            q = (vp / scale).round().clamp(-limit, limit).to(torch.int8).view(r, ng*g)[:, :self.width]
            if self.bits == 4:
                q = (q.to(torch.int16) + 8).to(torch.uint8)
                if self.width % 2: q = torch.nn.functional.pad(q, (0, 1), value=8)
                q = q[:, ::2] | (q[:, 1::2] << 4)
            packed[start:start+r] = q
            scales[start:start+r] = scale.view(r, ng)
        return packed, scales

    def forward(self, q, scale):
        if self.bits == 4:
            q = torch.stack((q & 15, q >> 4), dim=-1).flatten(1)[:, :self.width]
            q = q.to(torch.int8) - 8
        scale = scale.to(self.dtype)
        if scale.shape[1] > 1:
            scale = scale.repeat_interleave(self.group, dim=1)[:, :self.width]
        return q.to(self.dtype) * scale


def quantize(model, bits, group=0, int8=()):
    """Quantize every 2-D float matrix under `blocks.`. `group` sets the scale group (0 = per row).
    Matrices whose name contains any string in `int8` are stored at 8 bits instead (mixed precision)."""
    if any(parametrize.is_parametrized(m) for m in model.modules()):
        raise ValueError('Model already contains parametrizations')
    int8 = tuple(int8)
    model.requires_grad_(False)
    targets = [(name, m, p) for name, m in model.named_modules()
               for p, v in m.named_parameters(recurse=False)
               if name.startswith('blocks.') and v.ndim == 2 and v.is_floating_point()]
    if not targets: raise ValueError('No PAN2 block matrices found; architecture mismatch')
    before = sum(p.numel()*p.element_size() for p in model.parameters())
    records = []
    covered = 0
    for name, module, key in targets:
        value = getattr(module, key)
        covered += value.numel() * value.element_size()
        full = name + '.' + key
        use = 8 if bits == 4 and any(t in full for t in int8) else bits
        records.append({'name': full, 'shape': list(value.shape), 'bits': use})
        parametrize.register_parametrization(module, key, RowQuant(use, value.shape[1], value.dtype, group))
        del value
    after = sum(p.numel()*p.element_size() for p in model.parameters())
    return {'bits': bits, 'group': group, 'int8_patterns': list(int8), 'covered_source_bytes': covered,
            'compute': 'dense BF16 reconstructed per access',
            'parameter_bytes_before': before, 'parameter_bytes_after': after, 'targets': records}

def save_quantized(model, path, bits, group=0, int8=()):
    """Runtime state, not a native PAN2 checkpoint. Do not edit with WSP."""
    from safetensors.torch import save_file
    from pathlib import Path
    if Path(path).exists(): raise FileExistsError(path)
    save_file({k:v.detach().contiguous() for k,v in model.state_dict().items()},str(path),
              metadata={'schema':'pan2kit.quant-state/2','bits':str(bits),'group':str(group),'int8':json.dumps(list(int8))})

def quant_meta(path):
    """Return (bits, group, int8 patterns) recorded in a saved quantized state, without reading tensors."""
    from safetensors import safe_open
    with safe_open(str(path),framework='pt',device='cpu') as f:
        meta=f.metadata() or {}
    if meta.get('schema')!='pan2kit.quant-state/2': raise ValueError('Unsupported quant state schema')
    return int(meta['bits']), int(meta['group']), json.loads(meta['int8'])

def check_quant_args(path, bits, group, int8):
    """Refuse a saved state whose recorded settings differ from the requested ones."""
    got=quant_meta(path); want=(bits, group, sorted(int8))
    if (got[0], got[1], sorted(got[2]))!=want:
        raise ValueError(f'Quantized state {path} was saved with bits={got[0]} group={got[1]} int8={got[2]}, not the requested {want}')

def load_quantized(model, path):
    """Reconstruct matching parametrizations, then strictly load packed state on CPU."""
    from safetensors import safe_open
    from safetensors.torch import load_file
    with safe_open(str(path),framework='pt',device='cpu') as f:
        meta=f.metadata() or {}
    if meta.get('schema')!='pan2kit.quant-state/2': raise ValueError('Unsupported quant state schema')
    bits=int(meta['bits']); report=quantize(model,bits,int(meta['group']),json.loads(meta['int8']))
    # A model built on the meta device holds no storage: take the loaded tensors as they are instead of copying.
    meta=[n for n,p in model.named_parameters() if p.is_meta]
    model.load_state_dict(load_file(str(path),device='cpu'),strict=True,assign=bool(meta))
    left=[n for n,t in list(model.named_parameters())+list(model.named_buffers()) if t.is_meta]
    if left: raise ValueError(f'{len(left)} tensors are still on the meta device after loading, e.g. {left[:3]}')
    return report


def install_meta_builder(gen):
    """Make upstream build the transformer on the meta device (no storage), for use with a saved quantized state.

    Upstream builds the whole BF16 transformer in host memory and then overwrites it; with a saved state that is
    58 GB of throwaway allocation. `load_quantized` fills a meta-built model with the packed tensors instead.
    """
    pipeline = gen.PanVideoPipeline
    model_class = pipeline.build_transformer.__func__.__globals__['PanVideoDiffusionTransformer']
    def build(cls, transformer_config_overrides=None, pretrained_transformer_path=None, load_transformer_weights=False,
              transformer_dtype=torch.bfloat16, device=None):
        with torch.device('meta'):
            model = model_class.from_config(cls.architecture(transformer_config_overrides))
        return model.to(dtype=transformer_dtype)
    pipeline.build_transformer = classmethod(build)
