"""Pass/fail gate: is a quantized clip close enough to the BF16 clip made from the same prompt and seed?

Uses ffmpeg's ssim and psnr filters on the two videos. This measures similarity to the BF16 output for the
cases given, not perceptual quality, and one prompt proves little: the metaharness evaluator's 30 matched
cases are still the real test. The gate exists to stop obviously broken variants (noise) early.
"""
import re, shutil, subprocess

# From the smoke runs: INT8 vs BF16 measured SSIM 0.914 / PSNR 27.5 dB; INT4 per-row vs BF16 measured 0.591 / 13.2 dB.
MIN_SSIM, MIN_PSNR = 0.85, 24.0


def _filter(ref, cand, name):
    if not shutil.which('ffmpeg'): raise RuntimeError('ffmpeg is required')
    p = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', str(cand), '-i', str(ref), '-lavfi', name, '-f', 'null', '-'],
                       capture_output=True, text=True)
    if p.returncode: raise ValueError('ffmpeg could not compare the clips (size or format mismatch?): ' + p.stderr.strip()[-300:])
    return p.stderr


def parse_ssim(text):
    m = re.search(r'SSIM .*All:([0-9.]+)', text)
    if not m: raise ValueError('no SSIM in ffmpeg output')
    return float(m.group(1))


def parse_psnr(text):
    m = re.search(r'PSNR .*average:([0-9.a-z]+)', text)
    if not m: raise ValueError('no PSNR in ffmpeg output')
    return float('inf') if m.group(1) == 'inf' else float(m.group(1))


def compare(ref, cand, min_ssim=MIN_SSIM, min_psnr=MIN_PSNR):
    ssim = parse_ssim(_filter(ref, cand, 'ssim'))
    psnr = parse_psnr(_filter(ref, cand, 'psnr'))
    ok = ssim >= min_ssim and psnr >= min_psnr
    return {'ssim': ssim, 'psnr_db': psnr, 'min_ssim': min_ssim, 'min_psnr_db': min_psnr,
            'verdict': 'pass' if ok else 'fail',
            'scope': 'similarity to the BF16 clip for this prompt and seed; not a perceptual or physical validation'}
