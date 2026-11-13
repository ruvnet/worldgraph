import argparse, hashlib, importlib.util, json, os, resource, sys, time
from pathlib import Path
import torch
from pan2kit.quant import quantize, save_quantized, load_quantized, check_quant_args

def sha(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for chunk in iter(lambda:f.read(8*1024*1024), b''): h.update(chunk)
    return h.hexdigest()

def main():
    p=argparse.ArgumentParser(); p.add_argument('--attn',choices=['fa4','sdpa'],default='fa4'); p.add_argument('--repo',required=True); p.add_argument('--bits',type=int,choices=[0,4,8],required=True); p.add_argument('--receipt',required=True); p.add_argument('--group',type=int,default=0); p.add_argument('--int8',default=''); p.add_argument('--export-quant',action='store_true'); p.add_argument('--quant-state'); p.add_argument('--assets-manifest')
    args, native=p.parse_known_args()
    repo=Path(args.repo).resolve(); sys.path.insert(0,str(repo)); os.chdir(repo)
    attn_state=None
    if args.attn=='sdpa':
        from pan2kit.compat import install_sdpa
        attn_state=install_sdpa()
    spec=importlib.util.spec_from_file_location('pan_native_generate',repo/'generate.py')
    gen=importlib.util.module_from_spec(spec); spec.loader.exec_module(gen)
    if attn_state: attn_state.verify()
    original=gen.load_transformer_weights
    report={'attention_backend':args.attn,'compute_capability':list(torch.cuda.get_device_capability(0)),'torch_version':torch.__version__,'cuda_version':torch.version.cuda,'gpu':torch.cuda.get_device_name(0),'vram_bytes':torch.cuda.get_device_properties(0).total_memory,'status':'running','bits':args.bits,'quality_validation':'pending'}
    if args.assets_manifest:
        from pan2kit.assets import verify_encoder
        report['encoder_snapshot']=verify_encoder(args.assets_manifest)
    def load(pipe,*a,**kw):
        phase=time.monotonic()
        if args.quant_state:
            ints=[t for t in args.int8.split(',') if t]
            check_quant_args(args.quant_state,args.bits,args.group,ints)
            report['quantization']=load_quantized(pipe.transformer,args.quant_state)
            report['quantization_seconds']=time.monotonic()-phase
            report['quantized_state']={'path':args.quant_state,'sha256':sha(args.quant_state),'loaded':True}
            return None
        result=original(pipe,*a,**kw)
        report['checkpoint_load_seconds']=time.monotonic()-phase
        if args.bits:
            phase=time.monotonic()
            report['quantization']=quantize(pipe.transformer,args.bits,args.group,[t for t in args.int8.split(',') if t])
            report['quantization_seconds']=time.monotonic()-phase
            if args.export_quant:
                path=Path(args.receipt).with_name('quantized.safetensors')
                save_quantized(pipe.transformer,path,args.bits,args.group,[t for t in args.int8.split(',') if t])
                report['quantized_state']={'path':str(path),'sha256':sha(path)}
        return result
    gen.load_transformer_weights=load
    original_call=gen.PanVideoPipeline.__call__
    def timed_call(pipe,*a,**kw):
        torch.cuda.synchronize()
        phase=time.monotonic()
        try:
            return original_call(pipe,*a,**kw)
        finally:
            torch.cuda.synchronize()
            report['pipeline_seconds']=time.monotonic()-phase
    gen.PanVideoPipeline.__call__=timed_call
    torch.cuda.reset_peak_memory_stats(); started=time.monotonic()
    try:
        gen.main(native)
        out=Path(native[native.index('--output_path')+1])
        if not out.is_file() or out.stat().st_size==0: raise RuntimeError('PAN2 did not produce output')
        report.update(status='completed',output=str(out),output_sha256=sha(out))
    except BaseException as e:
        report.update(status='failed',error=repr(e)); raise
    finally:
        report.update(elapsed_seconds=time.monotonic()-started,peak_allocated_bytes=torch.cuda.max_memory_allocated(),peak_reserved_bytes=torch.cuda.max_memory_reserved(),cpu_peak_rss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
        Path(args.receipt).write_text(json.dumps(report,indent=2)+'\n')
if __name__=='__main__': main()
