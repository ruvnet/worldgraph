import unittest
import tempfile
from pathlib import Path
import torch
from torch import nn
from pan2kit.quant import quantize, save_quantized, load_quantized

class Raw(nn.Module):
    def __init__(self):
        super().__init__(); self.w=nn.Parameter(torch.randn(64,65,dtype=torch.bfloat16)); self.bias=nn.Parameter(torch.ones(64,dtype=torch.bfloat16))
    def forward(self,x): return x@self.w.T+self.bias
class Model(nn.Module):
    def __init__(self):
        super().__init__(); self.blocks=nn.ModuleList([Raw()]); self.out=nn.Linear(64,4,dtype=torch.bfloat16)

class QuantTests(unittest.TestCase):
    def test_raw_weights_4_and_8(self):
        for bits in (4,8):
            torch.manual_seed(42); m=Model(); before=m.blocks[0].w.detach().clone(); bias=m.blocks[0].bias.detach().clone(); out=m.out.weight.detach().clone()
            report=quantize(m,bits); after=m.blocks[0].w
            self.assertEqual(after.shape,before.shape); self.assertEqual(after.dtype,before.dtype)
            bound=before.float().abs().amax(1,keepdim=True)/(7 if bits==4 else 127)/2+0.04
            self.assertTrue(((after.float()-before.float()).abs()<=bound).all())
            self.assertLess(report['parameter_bytes_after'],report['parameter_bytes_before'])
            self.assertTrue(torch.equal(bias,m.blocks[0].bias)); self.assertTrue(torch.equal(out,m.out.weight))
            self.assertEqual(m.blocks[0].parametrizations.w.original0.dtype,torch.uint8 if bits==4 else torch.int8)
            self.assertFalse(hasattr(m.blocks[0].parametrizations.w,'original'))
            self.assertTrue(torch.isfinite(m.blocks[0](torch.ones(1,65,dtype=torch.bfloat16))).all())
            with self.assertRaises(ValueError): quantize(m,bits)
    def test_zero_and_reload(self):
        m=Model(); m.blocks[0].w.data.zero_(); quantize(m,4)
        self.assertEqual(m.blocks[0].w.count_nonzero(),0)
        n=Model(); quantize(n,4); n.load_state_dict(m.state_dict(),strict=True)
        self.assertTrue(torch.equal(m.blocks[0].w,n.blocks[0].w))
    def test_safetensors_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            for bits in (4,8):
                m=Model(); quantize(m,bits); path=Path(d)/f'{bits}.safetensors'
                save_quantized(m,path,bits); n=Model(); load_quantized(n,path)
                self.assertTrue(torch.equal(m.blocks[0].w,n.blocks[0].w))
                with self.assertRaises(FileExistsError): save_quantized(m,path,bits)
    def test_no_targets(self):
        with self.assertRaises(ValueError): quantize(nn.Linear(4,4),8)
    def test_nonfinite(self):
        m=Model(); m.blocks[0].w.data[0,0]=float('nan')
        with self.assertRaises(ValueError): quantize(m,8)
if __name__=='__main__': unittest.main()
