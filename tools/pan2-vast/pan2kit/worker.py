import argparse, hashlib, importlib.util, json, os, resource, sys, time
from pathlib import Path
import torch
from pan2kit.quant import quantize, save_quantized

def sha(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for chunk in iter(lambda:f.read(8*1024*1024), b''): h.update(chunk)
    return h.hexdigest()

def main():
    p=argparse.ArgumentParser(); p.add_argument('--repo',required=True); p.add_argument('--bits',type=int,choices=[0,4,8],required=True); p.add_argument('--receipt',required=True); p.add_argument('--export-quant',action='store_true')
    args, native=p.parse_known_args()
    repo=Path(args.repo).resolve(); sys.path.insert(0,str(repo)); os.chdir(repo)
    spec=importlib.util.spec_from_file_location('pan_native_generate',repo/'generate.py')
    gen=importlib.util.module_from_spec(spec); spec.loader.exec_module(gen)
    original=gen.load_transformer_weights
    report={'torch_version':torch.__version__,'cuda_version':torch.version.cuda,'gpu':torch.cuda.get_device_name(0),'vram_bytes':torch.cuda.get_device_properties(0).total_memory,'status':'running','bits':args.bits,'quality_validation':'pending'}
    def load(pipe,*a,**kw):
        phase=time.monotonic()
        result=original(pipe,*a,**kw)
        report['checkpoint_load_seconds']=time.monotonic()-phase
        if args.bits:
            phase=time.monotonic()
            report['quantization']=quantize(pipe.transformer,args.bits)
            report['quantization_seconds']=time.monotonic()-phase
            if args.export_quant:
                path=Path(args.receipt).with_name('quantized.safetensors')
                save_quantized(pipe.transformer,path,args.bits)
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
