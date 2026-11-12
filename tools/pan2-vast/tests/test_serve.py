import argparse, json, tempfile, threading, unittest, urllib.error, urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from pan2kit.serve import Feed, State, make_handler, validate

CAPS = {'max_frames': 9, 'max_pixels': 256 * 448, 'max_steps': 4}


class ValidateTests(unittest.TestCase):
    def test_defaults_are_the_verified_smoke_size(self):
        self.assertEqual(validate({'prompt': ' a ball '}, CAPS),
                         {'prompt': 'a ball', 'seed': 42, 'frames': 9, 'height': 256, 'width': 448, 'steps': 4})

    def test_rejects_what_the_caps_and_model_do_not_allow(self):
        for body in [{}, {'prompt': ''}, {'prompt': 'x', 'frames': 17}, {'prompt': 'x', 'frames': 8},
                     {'prompt': 'x', 'height': 250}, {'prompt': 'x', 'height': 512, 'width': 512},
                     {'prompt': 'x', 'steps': 5}, {'prompt': 'x', 'seed': -1}, {'prompt': 'x', 'seed': 1.5},
                     {'prompt': 'x', 'extra': 1}, {'prompt': 'x' * 9000}, ['x']]:
            with self.assertRaises(ValueError, msg=body):
                validate(body, CAPS)


def run_loop(tasks, generate):
    """The shape of the upstream loop: iterate jobs, generate, write the output file."""
    for index, job in enumerate(tasks, start=1):
        data = generate(job)
        if data is not None:
            Path(job.output_path).write_bytes(data)


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = State(CAPS, {'bits': 4, 'attention_backend': 'sdpa'})
        self.args = argparse.Namespace(video_height=0, video_width=0, seed=0)
        self.seen = []
        feed = Feed(self.state, self.args, argparse.Namespace(prompt='warm', video_length=9, num_inference_steps=4, output_path=None), self.tmp.name)

        def generate(job):
            self.seen.append((job.prompt, self.args.seed, self.args.video_height, self.args.video_width))
            if job.prompt == 'boom':
                self.state.current.error = 'RuntimeError("boom")'
                return None
            return b'mp4-' + job.prompt.encode()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(self.state, 10))
        self.url = 'http://127.0.0.1:%d' % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.loop = threading.Thread(target=run_loop, args=(feed, generate), daemon=True)

    def tearDown(self):
        self.state.jobs.put(None)
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def call(self, path, body=None):
        request = urllib.request.Request(self.url + path, data=None if body is None else json.dumps(body).encode())
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_not_ready_until_the_model_loop_starts(self):
        self.assertEqual(self.call('/health')[0], 503)
        self.assertEqual(self.call('/generate', {'prompt': 'x'})[0], 503)
        self.loop.start()
        self.assertTrue(self.state.ready.wait(5))
        self.assertEqual(self.call('/health')[0], 200)

    def test_requests_reuse_one_loop_and_carry_their_own_settings(self):
        self.loop.start()
        self.state.ready.wait(5)
        code, first = self.call('/generate', {'prompt': 'one', 'seed': 7})
        self.assertEqual(code, 200)
        import base64
        self.assertEqual(base64.b64decode(first['video_b64']), b'mp4-one')
        self.assertEqual(first['bits'], 4)
        code, second = self.call('/generate', {'prompt': 'two', 'height': 224, 'width': 448})
        self.assertEqual(code, 200)
        self.assertEqual(self.seen, [('one', 7, 256, 448), ('two', 42, 224, 448)])
        self.assertEqual(list(Path(self.tmp.name).iterdir()), [])

    def test_a_failed_generation_reports_500_and_the_server_keeps_serving(self):
        self.loop.start()
        self.state.ready.wait(5)
        code, body = self.call('/generate', {'prompt': 'boom'})
        self.assertEqual(code, 500)
        self.assertIn('boom', body['error'])
        self.assertEqual(self.call('/generate', {'prompt': 'after'})[0], 200)

    def test_bad_input_is_400(self):
        self.loop.start()
        self.state.ready.wait(5)
        self.assertEqual(self.call('/generate', {'prompt': 'x', 'frames': 81})[0], 400)
        self.assertEqual(self.call('/nope', {'prompt': 'x'})[0], 404)


if __name__ == '__main__':
    unittest.main()
