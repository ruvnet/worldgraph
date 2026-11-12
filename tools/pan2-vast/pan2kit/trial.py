"""One GPU variant; no BF16 control is implicitly scheduled."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from pan2kit import PAN_COMMIT


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for data in iter(lambda: f.read(8 * 1024 * 1024), b''):
            h.update(data)
    return h.hexdigest()


def atomic_json(path, value):
    path = Path(path)
    temp = path.with_suffix(path.suffix + '.tmp')
    with temp.open('w') as f:
        json.dump(value, f, indent=2, allow_nan=False)
        f.write('\n'); f.flush(); os.fsync(f.fileno())
    os.replace(temp, path)


def verify_repo(repo):
    sha = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
    dirty = subprocess.check_output(['git', '-C', str(repo), 'status', '--porcelain', '--untracked-files=no'], text=True).strip()
    if sha != PAN_COMMIT or dirty:
        raise ValueError('PAN2 must be clean and match its pinned revision')


def command(job, output):
    output = Path(output).resolve()
    args = [sys.executable, '-m', 'torch.distributed.run', '--standalone', '--nproc_per_node=1',
            '--module', 'pan2kit.worker', '--repo', job['repo'], '--bits', str(job['bits']),
            '--receipt', str(output / 'worker.json'), '--checkpoint_path', job['checkpoint'],
            '--prompt', job['prompt'], '--wan_vae_checkpoint', job['vae'], '--dtype', 'bf16',
            '--offload', 'models', '--offload_prefetch', 'false', '--compile', 'false',
            '--seed', str(job['seed']), '--output_path', str(output / 'output.mp4')]
    for key, flag in [('frames', '--video_length'), ('height', '--video_height'),
                      ('width', '--video_width'), ('steps', '--num_inference_steps')]:
        args += [flag, str(job[key])]
    args += ['--assets-manifest', job['assets_manifest']]
    if job.get('training_config'):
        args += ['--training_config', job['training_config']]
    return args


def execute(job, output):
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    argv = command(job, output)
    env = os.environ.copy()
    env['PYTHONPATH'] = str(Path(__file__).resolve().parent.parent) + os.pathsep + env.get('PYTHONPATH', '')
    env['HF_HUB_OFFLINE'] = '1'
    started = time.monotonic()
    result = {'status': 'failed', 'command': argv}
    try:
        with (output / 'run.log').open('w') as log:
            proc = subprocess.Popen(argv, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                result['returncode'] = proc.wait(timeout=job['timeout_seconds'])
            except BaseException:
                try: os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                proc.wait()
                raise
        if result['returncode'] != 0:
            raise RuntimeError('GPU worker failed')
        worker = json.loads((output / 'worker.json').read_text())
        video = output / 'output.mp4'
        if (worker.get('status') != 'completed' or not video.is_file()
                or video.stat().st_size == 0 or worker.get('output_sha256') != digest(video)):
            raise ValueError('Worker output evidence mismatch')
        result.update(status='completed', worker=worker, output_sha256=digest(video))
    except (Exception, KeyboardInterrupt) as error:
        result['error'] = repr(error)
    finally:
        result['elapsed_seconds'] = time.monotonic() - started
        atomic_json(output / 'trial.json', result)
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--plan', required=True)
    p.add_argument('--job-id', required=True)
    p.add_argument('--output', required=True)
    a = p.parse_args()
    from pan2kit.metaharness import verify_inputs, validate_plan
    plan = json.loads(Path(a.plan).read_text()); validate_plan(plan)
    matches = [j for j in plan['jobs'] if j['id'] == a.job_id]
    if len(matches) != 1: raise ValueError('Unknown job ID')
    job = matches[0]
    verify_repo(job['repo']); verify_inputs(plan['inputs'])
    result = execute(job, a.output)
    verify_inputs(plan['inputs'])
    if result['status'] != 'completed': raise SystemExit(1)

if __name__ == '__main__': main()
