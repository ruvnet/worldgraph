"""Vast.ai Serverless PyWorker for the PAN2 generation server (pan2kit.serve).

Vast's worker framework is a Python SDK, so this file is Python by necessity. It only proxies: one route,
one request at a time, and a single smallest-size benchmark run so a worker becomes ready after one clip.
"""
import os
from vastai import Worker, WorkerConfig, HandlerConfig, LogActionConfig, BenchmarkConfig

SMOKE = {'prompt': 'a red ball bounces on a wooden floor', 'seed': 42, 'frames': 9, 'height': 256, 'width': 448, 'steps': 4}

worker_config = WorkerConfig(
    model_server_url='http://127.0.0.1',
    model_server_port=int(os.environ.get('PAN2_PORT', '18300')),
    model_log_file=os.environ.get('MODEL_LOG', '/workspace/pan2-server.log'),
    model_healthcheck_url='/health',
    handlers=[
        HandlerConfig(
            route='/generate',
            allow_parallel_requests=False,
            max_queue_time=float(os.environ.get('PAN2_MAX_QUEUE_SECONDS', '900')),
            benchmark_config=BenchmarkConfig(dataset=[SMOKE], runs=1, concurrency=1, do_warmup=False),
            # Load is counted in generated frames, so the autoscaler sees longer clips as more work.
            workload_calculator=lambda payload: float(payload.get('frames', 9)),
        )
    ],
    log_action_config=LogActionConfig(
        on_load=['PAN2_SERVER_READY'],
        on_error=['PAN2_SERVER_ERROR fatal', 'PAN2_SETUP_FAILED'],
        on_info=['Fetching', '=== '],
    ),
)

if __name__ == '__main__':
    Worker(worker_config).run()
