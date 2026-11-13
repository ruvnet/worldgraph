"""Long-lived PAN2 generation server: load (and optionally quantize) the model once, then serve requests.

The pinned upstream generate.py builds the pipeline and then loops over a list of prompt jobs. This module
hands that loop a list whose iterator blocks on an HTTP request queue, so every request runs through the
exact upstream generation and video-writing path while the model stays in memory. Nothing in the pinned
PAN2 checkout is modified.

One request runs at a time. Requests are capped (frames, pixels, steps) to the sizes this kit has run;
the output is a generated clip, not a measurement, and quality of quantized variants is unvalidated.
"""
import argparse, base64, copy, hashlib, importlib.util, json, os, queue, sys, threading, time, types, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

READY_LINE = 'PAN2_SERVER_READY'
ERROR_LINE = 'PAN2_SERVER_ERROR'


def validate(body, caps):
    """Return normalized settings or raise ValueError. `caps` holds max_frames, max_pixels, max_steps."""
    if not isinstance(body, dict):
        raise ValueError('Body must be a JSON object')
    unknown = set(body) - {'prompt', 'seed', 'frames', 'height', 'width', 'steps'}
    if unknown:
        raise ValueError('Unknown fields: ' + ', '.join(sorted(unknown)))
    prompt = body.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt.encode()) > 8192:
        raise ValueError('prompt must be a non-empty string of at most 8192 bytes')

    def integer(name, default, low, high):
        value = body.get(name, default)
        if type(value) is not int or not low <= value <= high:
            raise ValueError(f'{name} must be an integer in [{low}, {high}]')
        return value
    frames = integer('frames', 9, 1, caps['max_frames'])
    height = integer('height', 256, 32, 4096)
    width = integer('width', 448, 32, 4096)
    steps = integer('steps', 4, 1, caps['max_steps'])
    seed = integer('seed', 42, 0, 2**31 - 1)
    if (frames - 1) % 8:
        raise ValueError('frames must be 8n+1')
    if height % 32 or width % 32:
        raise ValueError('height and width must be divisible by 32')
    if height * width > caps['max_pixels']:
        raise ValueError(f'height*width exceeds the cap of {caps["max_pixels"]} pixels')
    return {'prompt': prompt.strip(), 'seed': seed, 'frames': frames, 'height': height, 'width': width, 'steps': steps}


class Request:
    def __init__(self, settings):
        self.id = uuid.uuid4().hex
        self.settings = settings
        self.done = threading.Event()
        self.error = None
        self.result = None
        self.queued = time.monotonic()
        self.started = None


class Feed(list):
    """A job list for the upstream loop: iterating blocks on the request queue and never ends on its own."""

    def __init__(self, state, args, template, outdir):
        super().__init__()
        self.state, self.args, self.template, self.outdir = state, args, template, Path(outdir)

    def __len__(self):
        return 1

    def __bool__(self):
        return True

    def __iter__(self):
        self.state.mark_ready()
        while True:
            request = self.state.jobs.get()
            if request is None:
                return
            s = request.settings
            # Upstream reads size and seed from the shared args, and the rest from the per-job copy.
            self.args.video_height, self.args.video_width, self.args.seed = s['height'], s['width'], s['seed']
            job = copy.copy(self.template)
            job.prompt, job.video_length, job.num_inference_steps = s['prompt'], s['frames'], s['steps']
            job.output_path = str(self.outdir / (request.id + '.mp4'))
            self.state.current = request
            request.started = time.monotonic()
            try:
                yield job  # the upstream loop body runs here: generate, then write the video
            finally:
                self.state.finish(request, job.output_path)


class State:
    def __init__(self, caps, info):
        self.caps, self.info = caps, info
        self.jobs = queue.Queue(maxsize=4)
        self.ready = threading.Event()
        self.current = None
        self.completed = 0
        self.on_ready = None

    def mark_ready(self):
        if not self.ready.is_set():
            if self.on_ready:
                self.on_ready()
            self.ready.set()
            print(READY_LINE, flush=True)

    def finish(self, request, path):
        seconds = time.monotonic() - request.started
        path = Path(path)
        if request.error is None and (not path.is_file() or path.stat().st_size == 0):
            request.error = 'PAN2 did not produce output'
        if request.error is None:
            data = path.read_bytes()
            request.result = {'id': request.id, 'settings': request.settings, 'seconds': round(seconds, 3),
                              'queue_seconds': round(request.started - request.queued, 3), 'bytes': len(data),
                              'sha256': hashlib.sha256(data).hexdigest(), 'content_type': 'video/mp4',
                              'video_b64': base64.b64encode(data).decode(), 'label': 'generated, not a measurement',
                              'quality_validation': 'pending', **self.info}
            self.completed += 1
        path.unlink(missing_ok=True)
        self.current = None
        request.done.set()


def make_handler(state, timeout):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, fmt, *a):
            print('http ' + fmt % a, flush=True)

        def send(self, code, payload):
            data = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == '/health':
                ok = state.ready.is_set()
                self.send(200 if ok else 503, {'status': 'ready' if ok else 'loading', 'busy': state.current is not None,
                                               'completed': state.completed, 'caps': state.caps, **state.info})
            else:
                self.send(404, {'error': 'not found'})

        def do_POST(self):
            if self.path != '/generate':
                return self.send(404, {'error': 'not found'})
            if not state.ready.is_set():
                return self.send(503, {'error': 'model is still loading'})
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 65536:
                    raise ValueError('Body must be 1..65536 bytes')
                settings = validate(json.loads(self.rfile.read(length)), state.caps)
            except (ValueError, json.JSONDecodeError) as e:
                return self.send(400, {'error': str(e)})
            request = Request(settings)
            try:
                state.jobs.put_nowait(request)
            except queue.Full:
                return self.send(429, {'error': 'queue is full'})
            if not request.done.wait(timeout):
                return self.send(504, {'error': 'generation timed out', 'id': request.id})
            if request.error:
                return self.send(500, {'error': request.error, 'id': request.id})
            self.send(200, request.result)
    return Handler


def main():
    import resource
    import torch
    from pan2kit.quant import quantize, load_quantized, check_quant_args, save_quantized, install_meta_builder
    p = argparse.ArgumentParser()
    p.add_argument('--attn', choices=['fa4', 'sdpa'], default='fa4')
    p.add_argument('--repo', required=True)
    p.add_argument('--bits', type=int, choices=[0, 4, 8], required=True)
    p.add_argument('--group', type=int, default=0, help='scale group size for quantization (0 = per row)')
    p.add_argument('--int8', default='', help='comma list of matrix-name fragments kept at 8 bits when --bits 4')
    p.add_argument('--quant-state', help='saved quantized state (pan2kit.quant-state/2); skips reading the BF16 checkpoint')
    p.add_argument('--export-quant', help='write the quantized state to this new file after quantizing, then keep serving')
    p.add_argument('--host', default='127.0.0.1')
    p.add_argument('--port', type=int, default=18300)
    p.add_argument('--workdir', required=True)
    p.add_argument('--max-frames', type=int, default=9)
    p.add_argument('--max-pixels', type=int, default=256 * 448)
    p.add_argument('--max-steps', type=int, default=4)
    p.add_argument('--request-timeout', type=float, default=1800)
    args, native = p.parse_known_args()
    workdir = Path(args.workdir).resolve()
    workdir.mkdir(parents=True, exist_ok=True)
    repo = Path(args.repo).resolve()
    sys.path.insert(0, str(repo))
    os.chdir(repo)
    attn_state = None
    if args.attn == 'sdpa':
        from pan2kit.compat import install_sdpa
        attn_state = install_sdpa()
    spec = importlib.util.spec_from_file_location('pan_native_generate', repo / 'generate.py')
    gen = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gen)
    if attn_state:
        attn_state.verify()
    if args.quant_state:
        install_meta_builder(gen)

    info = {'attention_backend': args.attn, 'bits': args.bits, 'group': args.group, 'int8': args.int8, 'gpu': torch.cuda.get_device_name(0),
            'compute_capability': list(torch.cuda.get_device_capability(0)), 'pan_commit': None}
    try:
        from pan2kit import PAN_COMMIT
        info['pan_commit'] = PAN_COMMIT
    except Exception:
        pass
    caps = {'max_frames': args.max_frames, 'max_pixels': args.max_pixels, 'max_steps': args.max_steps}
    state = State(caps, info)
    receipt = {'status': 'loading', **info, 'caps': caps}
    started = time.monotonic()

    original_load = gen.load_transformer_weights

    def load(pipe, *a, **kw):
        phase = time.monotonic()
        if args.quant_state:
            ints = [t for t in args.int8.split(',') if t]
            check_quant_args(args.quant_state, args.bits, args.group, ints)
            receipt['quantization'] = load_quantized(pipe.transformer, args.quant_state)
            receipt['quantization_seconds'] = time.monotonic() - phase
            receipt['quantized_state'] = args.quant_state
            return None
        result = original_load(pipe, *a, **kw)
        receipt['checkpoint_load_seconds'] = time.monotonic() - phase
        if args.bits:
            phase = time.monotonic()
            receipt['quantization'] = quantize(pipe.transformer, args.bits, args.group, [t for t in args.int8.split(',') if t])
            receipt['quantization_seconds'] = time.monotonic() - phase
            if args.export_quant:
                save_quantized(pipe.transformer, args.export_quant, args.bits, args.group, [t for t in args.int8.split(',') if t])
                receipt['exported_state'] = args.export_quant
        return result
    gen.load_transformer_weights = load

    original_call = gen.PanVideoPipeline.__call__

    def guarded_call(pipe, *a, **kw):
        try:
            return original_call(pipe, *a, **kw)
        except Exception as e:  # keep the server alive; the request reports the failure
            if state.current is not None:
                state.current.error = repr(e)
            print(ERROR_LINE + ' ' + repr(e), flush=True)
            torch.cuda.empty_cache()
            return types.SimpleNamespace(videos=None)
    gen.PanVideoPipeline.__call__ = guarded_call

    original_write = gen.write_video

    def write(video, path, *a, **kw):
        if video is None:
            return None
        return original_write(video, path, *a, **kw)
    gen.write_video = write

    original_prepare = gen.prepare_generation_inputs

    def prepare(native_args, task):
        template = original_prepare(native_args, task)[0]
        return Feed(state, native_args, template, workdir)
    gen.prepare_generation_inputs = prepare

    def on_ready():
        receipt.update(status='ready', ready_seconds=time.monotonic() - started,
                       load_peak_allocated_bytes=torch.cuda.max_memory_allocated(),
                       cpu_peak_rss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
        (workdir / 'server.json').write_text(json.dumps(receipt, indent=2) + '\n')
    state.on_ready = on_ready

    server = ThreadingHTTPServer((args.host, args.port), make_handler(state, args.request_timeout))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f'PAN2 server listening on {args.host}:{args.port}, loading model', flush=True)
    try:
        gen.main(native)
    except BaseException as e:
        print(ERROR_LINE + ' fatal ' + repr(e), flush=True)
        raise


if __name__ == '__main__':
    main()
