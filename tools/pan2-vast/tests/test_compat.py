import unittest
import torch
from pan2kit.compat import padded_sdpa_attention, varlen_sdpa


def naive(q, k, v, scale=None):
    """q [Lq,H,D], k/v [Lk,H,D] reference softmax attention."""
    scale = scale if scale is not None else q.shape[-1] ** -0.5
    s = torch.einsum('qhd,khd->hqk', q.double(), k.double()) * scale
    return torch.einsum('hqk,khd->qhd', s.softmax(-1), v.double()).to(q.dtype)


class CompatTests(unittest.TestCase):
    def setUp(self):
        torch.manual_seed(0)

    def test_dense_matches_naive(self):
        q, k, v = (torch.randn(2, 9, 3, 8) for _ in range(3))
        out = padded_sdpa_attention(q, k, v, softmax_scale=0.3)
        for b in range(2):
            torch.testing.assert_close(out[b], naive(q[b], k[b], v[b], 0.3), atol=1e-5, rtol=1e-4)

    def test_padded_rows_are_zero_and_keys_masked(self):
        q, k, v = (torch.randn(2, 7, 2, 4) for _ in range(3))
        mask = torch.tensor([[1, 1, 1, 1, 0, 0, 0], [1, 1, 1, 1, 1, 1, 0]], dtype=torch.bool)
        out = padded_sdpa_attention(q, k, v, mask, mask)
        for b in range(2):
            n = int(mask[b].sum())
            torch.testing.assert_close(out[b][:n], naive(q[b][:n], k[b][:n], v[b][:n]), atol=1e-5, rtol=1e-4)
            self.assertTrue(bool((out[b][n:] == 0).all()))

    def test_rectangular_query_key(self):
        q, k, v = torch.randn(1, 5, 2, 4), torch.randn(1, 11, 2, 4), torch.randn(1, 11, 2, 4)
        torch.testing.assert_close(padded_sdpa_attention(q, k, v)[0], naive(q[0], k[0], v[0]), atol=1e-5, rtol=1e-4)

    def test_varlen_segments_do_not_mix(self):
        q, k, v = (torch.randn(10, 2, 4) for _ in range(3))
        cu = torch.tensor([0, 3, 10], dtype=torch.int32)
        out = varlen_sdpa(q, k, v, cu, cu, 7, 7)
        self.assertEqual(tuple(out.shape), (10, 8))
        out = out.view(10, 2, 4)
        torch.testing.assert_close(out[:3], naive(q[:3], k[:3], v[:3]), atol=1e-5, rtol=1e-4)
        torch.testing.assert_close(out[3:], naive(q[3:], k[3:], v[3:]), atol=1e-5, rtol=1e-4)

    def test_varlen_seqused_zeroes_unused_rows(self):
        q, k, v = (torch.randn(8, 1, 4) for _ in range(3))
        cu = torch.tensor([0, 8], dtype=torch.int32)
        out = varlen_sdpa(q, k, v, cu, cu, 8, 8, seqused_q=torch.tensor([5]), seqused_k=torch.tensor([5])).view(8, 1, 4)
        torch.testing.assert_close(out[:5], naive(q[:5], k[:5], v[:5]), atol=1e-5, rtol=1e-4)
        self.assertTrue(bool((out[5:] == 0).all()))

    def test_causal_unequal_lengths_refused(self):
        q, k, v = torch.randn(1, 3, 1, 4), torch.randn(1, 5, 1, 4), torch.randn(1, 5, 1, 4)
        with self.assertRaises(NotImplementedError):
            padded_sdpa_attention(q, k, v, torch.ones(1, 3, dtype=torch.bool), torch.tensor([[1, 1, 1, 1, 0]], dtype=torch.bool), causal=True)


if __name__ == '__main__':
    unittest.main()


class WiringTests(unittest.TestCase):
    JOB = {'repo': 'r', 'bits': 4, 'checkpoint': 'c', 'prompt': 'p', 'vae': 'v', 'seed': 1, 'frames': 9, 'height': 256,
           'width': 448, 'steps': 4, 'assets_manifest': 'a'}

    def test_sdpa_backend_reaches_the_worker_command(self):
        from pan2kit.trial import command
        self.assertNotIn('--attn', command(dict(self.JOB), '/tmp/o'))
        argv = command({**self.JOB, 'attention': 'sdpa'}, '/tmp/o')
        self.assertEqual(argv[argv.index('--attn') + 1], 'sdpa')

    def test_attention_backend_changes_case_identity_and_is_validated(self):
        import tempfile, json, pathlib
        from pan2kit import metaharness
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            (d / 'vae').mkdir(); (d / 'vae' / 'f').write_text('x')
            (d / 'm').mkdir(); (d / 'm' / 'transformer').mkdir(); (d / 'm' / 'transformer' / 'model.safetensors').write_bytes(b'w')
            (d / 'prompt.txt').write_text('a ball')
            (d / 'assets.json').write_text('{"e": {"revision": "r1"}}')
            (d / 'config').mkdir(); (d / 'config' / 'sft_29B_720p.yaml').write_text('t: 1')
            def plan(att):
                cfg = {'schema': 'pan2-metaharness/1', 'repo': str(d), 'vae': 'vae', 'assets_manifest': 'assets.json',
                       'hardware_label': 'x', 'hourly_usd': 1, 'budget_usd': 10, 'setup_storage_transfer_usd': 1,
                       'timeout_seconds': 60, 'order_seed': 1, 'seeds': [1],
                       'settings': {'frames': 9, 'height': 256, 'width': 448, 'steps': 4, **({'attention': att} if att else {})},
                       'prompts': [{'id': 'p', 'file': 'prompt.txt'}],
                       'variants': [{'id': 'v', 'checkpoint': 'm', 'bits': 4}]}
                return metaharness.make_plan(cfg, str(d))
            a, b = plan(None), plan('sdpa')
            self.assertNotEqual(a['jobs'][0]['case_sha256'], b['jobs'][0]['case_sha256'])
            with self.assertRaises(ValueError):
                plan('bogus')
