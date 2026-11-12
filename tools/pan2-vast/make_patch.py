import argparse,json,math
from safetensors import safe_open
from pan2kit.__main__ import digest
p=argparse.ArgumentParser(); p.add_argument('--base',required=True); p.add_argument('--tensor',required=True); p.add_argument('--index',type=int,default=0); p.add_argument('--delta',type=float,required=True); p.add_argument('--output',required=True); a=p.parse_args()
if not math.isfinite(a.delta) or abs(a.delta)>1 or a.delta==0: raise ValueError('Use finite nonzero delta <=1')
with safe_open(a.base,framework='pt',device='cpu') as f:
    t=f.get_tensor(a.tensor); flat=t.reshape(-1)
    if a.index<0 or a.index>=flat.numel(): raise ValueError('Index out of range')
    value=float(flat[a.index])+a.delta
    if float(t.new_tensor(value))==float(flat[a.index]): raise ValueError('Edit rounds away in checkpoint dtype')
patch={'schema':'ruv-fann.tensor-patch/1','base_sha256':digest(a.base),'edits':[{'tensor':a.tensor,'index':a.index,'value':value}]}
with open(a.output,'x') as out: json.dump(patch,out,indent=2); out.write('\n')
