import argparse, hashlib, json, os, shutil, signal, subprocess, sys
from pathlib import Path
from pan2kit import PAN_COMMIT, WSP_COMMIT

def run(argv, **kw): return subprocess.run(argv,check=True,**kw)
def digest(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for b in iter(lambda:f.read(8*1024*1024),b''): h.update(b)
    return h.hexdigest()
def write(path,data): Path(path).write_text(json.dumps(data,indent=2)+'\n')
def checkout(dest,url,pin):
    dest=Path(dest).resolve()
    if dest.exists(): raise ValueError('Destination already exists')
    run(['git','clone','--filter=blob:none','--no-checkout',url,str(dest)])
    run(['git','-C',str(dest),'checkout','--detach',pin])
    return dest

def main():
    p=argparse.ArgumentParser(description='PAN2 Vast GPU experiment kit')
    sub=p.add_subparsers(dest='cmd',required=True)
    s=sub.add_parser('fetch'); s.add_argument('--repo',default='PAN2')
    s=sub.add_parser('doctor'); s.add_argument('--repo',required=True)
    s=sub.add_parser('build-wsp'); s.add_argument('--dest',default='wsp-source')
    s=sub.add_parser('edit'); s.add_argument('--binary',required=True); s.add_argument('--base',required=True); s.add_argument('--output',required=True); s.add_argument('--patch',required=True)
    s=sub.add_parser('matrix'); s.add_argument('--repo',required=True); s.add_argument('--base',required=True); s.add_argument('--edited',required=True); s.add_argument('--prompt-file',required=True); s.add_argument('--vae',required=True); s.add_argument('--output',required=True); s.add_argument('--training-config'); s.add_argument('--bits',type=int,choices=[4,8],default=8); s.add_argument('--seed',type=int,default=42); s.add_argument('--frames',type=int,default=9); s.add_argument('--height',type=int,default=256); s.add_argument('--width',type=int,default=448); s.add_argument('--steps',type=int,default=4); s.add_argument('--timeout',type=int,default=7200); s.add_argument('--save-quant',action='store_true')
    a=p.parse_args()
    if a.cmd=='fetch': checkout(a.repo,'https://github.com/ifm-ai/PAN2.git',PAN_COMMIT); return
    if a.cmd=='doctor':
        import torch
        repo=Path(a.repo).resolve(); actual=subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip()
        data={'expected_commit':PAN_COMMIT,'actual_commit':actual,'torch':torch.__version__,'cuda_available':torch.cuda.is_available(),'free_disk_bytes':shutil.disk_usage(repo).free}
        if torch.cuda.is_available(): data['gpu']={'name':torch.cuda.get_device_name(0),'vram_bytes':torch.cuda.get_device_properties(0).total_memory,'bf16':torch.cuda.is_bf16_supported()}
        print(json.dumps(data,indent=2))
        if actual!=PAN_COMMIT or not torch.cuda.is_available() or not torch.cuda.is_bf16_supported(): raise RuntimeError('Preflight failed')
        return
    if a.cmd=='build-wsp':
        dest=checkout(a.dest,'https://github.com/ruvnet/ruv-FANN.git',WSP_COMMIT)
        run(['cargo','build','--release','--manifest-path',str(dest/'crates/wsp-tensor/Cargo.toml')])
        print('Find the ruv-fann-wsp-tensor binary under the Cargo target/release directory.'); return
    if a.cmd=='edit':
        base,output,patch=map(lambda s:Path(s).resolve(),[a.base,a.output,a.patch])
        if output.exists() or Path(str(output)+'.receipt.json').exists(): raise ValueError('Output or receipt already exists')
        if base.is_symlink() or not base.is_file(): raise ValueError('Base must be a regular file')
        output.parent.mkdir(parents=True,exist_ok=True)
        receipt_path=Path(str(output)+'.receipt.json')
        with receipt_path.open('x') as f:
            run([str(Path(a.binary).resolve()),'apply',str(base),str(output),str(patch)],stdout=f)
        receipt=json.loads(receipt_path.read_text())
        print(json.dumps({'candidate':str(output),'receipt':str(receipt_path),'source_sha256':digest(base),'candidate_sha256':digest(output)},indent=2)); return
    if a.cmd=='matrix':
        repo=Path(a.repo).resolve(); out=Path(a.output).resolve()
        actual=subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip()
        if actual!=PAN_COMMIT: raise ValueError('PAN2 source does not match pinned revision')
        if subprocess.check_output(['git','-C',str(repo),'status','--porcelain','--untracked-files=no'],text=True).strip(): raise ValueError('PAN2 tracked source is modified')
        if a.seed<0 or a.frames<1 or (a.frames-1)%8 or a.steps<1 or a.height%16 or a.width%16 or min(a.height,a.width)<=0: raise ValueError('Use fixed seed, frames 8n+1, positive dimensions divisible by16 and steps')
        prompt_path=Path(a.prompt_file).resolve(); prompt=prompt_path.read_text().strip()
        if not prompt: raise ValueError('Prompt is empty')
        base,edited=Path(a.base).resolve(),Path(a.edited).resolve()
        # Native PAN2 expects checkpoint directory containing transformer/model.safetensors.
        fingerprints={}
        for key,root in [('base',base),('edited',edited)]:
            file=root/'transformer/model.safetensors'
            if not file.is_file(): raise ValueError(f'Missing native checkpoint {file}')
            fingerprints[key]=digest(file)
        if fingerprints['base']==fingerprints['edited']: raise ValueError('Edited checkpoint equals baseline')
        out.mkdir(parents=True,exist_ok=False)
        manifest={'schema':'pan2-vast-matrix/1','pan_commit':actual,'checkpoint_sha256':fingerprints,'prompt_sha256':digest(prompt_path),'seed':a.seed,'frames':a.frames,'height':a.height,'width':a.width,'steps':a.steps,'quality_validation':'pending','variants':[]}
        env=os.environ.copy(); kit=str(Path(__file__).resolve().parent.parent)
        env['PYTHONPATH']=kit+os.pathsep+env.get('PYTHONPATH',''); env['HF_HUB_OFFLINE']='1'
        for name,checkpoint,bits in [('base_bf16',base,0),('edited_bf16',edited,0),('base_quant',base,a.bits),('edited_quant',edited,a.bits)]:
            variant=out/name; variant.mkdir(); receipt=variant/'receipt.json'
            command=[sys.executable,'-m','torch.distributed.run','--standalone','--nproc_per_node=1','--module','pan2kit.worker','--repo',str(repo),'--bits',str(bits),'--receipt',str(receipt),'--checkpoint_path',str(checkpoint),'--prompt',prompt,'--wan_vae_checkpoint',str(Path(a.vae).resolve()),'--dtype','bf16','--offload','models','--offload_prefetch','false','--compile','false','--seed',str(a.seed),'--video_length',str(a.frames),'--video_height',str(a.height),'--video_width',str(a.width),'--num_inference_steps',str(a.steps),'--output_path',str(variant/'output.mp4')]
            if a.save_quant and bits: command.insert(command.index('--checkpoint_path'),'--export-quant')
            if a.training_config: command+=['--training_config',str(Path(a.training_config).resolve())]
            item={'name':name,'command':command,'status':'running'}; manifest['variants'].append(item); write(out/'matrix.json',manifest)
            with (variant/'run.log').open('w') as log:
                process=subprocess.Popen(command,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
                try: rc=process.wait(timeout=a.timeout)
                except (subprocess.TimeoutExpired,KeyboardInterrupt):
                    os.killpg(process.pid,signal.SIGKILL); process.wait(); item['status']='interrupted'; write(out/'matrix.json',manifest); raise
            item['returncode']=rc; item['status']='completed' if rc==0 and receipt.exists() else 'failed'
            if receipt.exists(): item['measurement']=json.loads(receipt.read_text())
            write(out/'matrix.json',manifest)
            if item['status']!='completed': raise RuntimeError(f'{name} failed. See {variant}/run.log')
        for key,root in [('base',base),('edited',edited)]:
            if digest(root/'transformer/model.safetensors')!=fingerprints[key]:
                manifest['source_integrity']='failed'; write(out/'matrix.json',manifest); raise RuntimeError('Source checkpoint changed during evaluation')
        manifest['source_integrity']='verified'; write(out/'matrix.json',manifest)
        print(str(out/'matrix.json'))
if __name__=='__main__': main()
