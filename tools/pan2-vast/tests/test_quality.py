import shutil, subprocess, tempfile, unittest
from pathlib import Path
from pan2kit.quality import compare, parse_psnr, parse_ssim

HAVE_FFMPEG = shutil.which('ffmpeg') is not None


def clip(path, extra=''):
    vf = ['-vf', extra] if extra else []
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=128x128:rate=8:duration=1', *vf,
                    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '12', str(path)], check=True)


class ParseTests(unittest.TestCase):
    def test_parse_ffmpeg_summary_lines(self):
        self.assertAlmostEqual(parse_ssim('[Parsed_ssim_0 @ 0x1] SSIM Y:0.9 U:0.9 V:0.9 All:0.932026 (11.6)'), 0.932026)
        self.assertEqual(parse_psnr('[Parsed_psnr_0 @ 0x1] PSNR y:30 u:30 v:30 average:28.390000 min:1 max:2'), 28.39)
        self.assertEqual(parse_psnr('PSNR y:inf average:inf min:inf max:inf'), float('inf'))
        with self.assertRaises(ValueError): parse_ssim('nothing')


@unittest.skipUnless(HAVE_FFMPEG, 'ffmpeg not installed')
class GateTests(unittest.TestCase):
    def test_identical_passes_noise_fails_and_size_mismatch_is_an_error(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d); clip(d/'ref.mp4'); clip(d/'same.mp4'); clip(d/'noisy.mp4', 'noise=alls=90:allf=t'); clip(d/'small.mp4', 'scale=64:64')
            self.assertEqual(compare(d/'ref.mp4', d/'same.mp4')['verdict'], 'pass')
            bad = compare(d/'ref.mp4', d/'noisy.mp4')
            self.assertEqual(bad['verdict'], 'fail'); self.assertLess(bad['ssim'], 0.85)
            with self.assertRaises(ValueError): compare(d/'ref.mp4', d/'small.mp4')


if __name__ == '__main__':
    unittest.main()
