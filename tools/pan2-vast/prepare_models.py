import argparse, json, subprocess, sys
from pathlib import Path
from huggingface_hub import snapshot_download
from pan2kit import PAN_COMMIT
p=argparse.ArgumentParser(); p.add_argument('--repo',required=True); p.add_argument('--dest',required=True); a=p.parse_args()
repo=Path(a.repo).resolve(); dest=Path(a.dest).resolve()
if subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip()!=PAN_COMMIT: raise RuntimeError('Unexpected PAN2 source revision')
dest.mkdir(parents=True,exist_ok=False)
records={}
for name,patterns in [('IFM/PAN2',['transformer/*']),('Qwen/Qwen3.5-9B',None),('Wan-AI/Wan2.2-TI2V-5B-Diffusers',['vae/*','model_index.json'])]:
    path=Path(snapshot_download(name,allow_patterns=patterns)).resolve()
    records[name]={'snapshot':str(path),'revision':path.name}
    (dest/'downloads.json').write_text(json.dumps(records,indent=2)+'\n')
subprocess.run([sys.executable,str(repo/'scripts/convert_checkpoint.py'),'to-native','--input',str(Path(records['IFM/PAN2']['snapshot'])/'transformer'),'--output',str(dest/'base/transformer')],check=True,cwd=repo)
(dest/'paths.json').write_text(json.dumps({'base':str(dest/'base'),'vae':records['Wan-AI/Wan2.2-TI2V-5B-Diffusers']['snapshot']},indent=2)+'\n')
print((dest/'paths.json').read_text())
