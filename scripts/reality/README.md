# Reality conditioning and Vast Serverless

This source implements a testable CONTROL PLANE, not a deployed neural video model. The GPU backend and Vast PyWorker are independent and require operator approval.

## Test without a GPU

Run from repository root:

    cargo test -p wifi-densepose-worldmodel --locked conditioning
    cargo run -p wifi-densepose-worldmodel --example reality_conditioning > /tmp/reality.json
    PYTHONPATH=scripts/reality python3 -c 'import json; from vast_client import validate_manifest; m=json.load(open("/tmp/reality.json")); validate_manifest(m,tenant="tenant",workspace="work",now_ms=1100); print(m["manifest_sha256"])'
    python3 -m unittest discover -v -s scripts/reality -p 'test_*.py'

The example is only a deterministic replay fixture. Its times are synthetic and deliberately small for tests. NEVER submit it to a live Vast endpoint.

## Vast client boundary

The adapter uses the official Vast Python SDK Serverless method. A live operation requires an existing reviewed endpoint with a custom worker implementing /v1/reality/render, a VAST_API_KEY inserted by an approved secret manager, and enable_remote=True.

The worker returns only metadata with EXACT keys: simulated, snapshot_hash, manifest_sha256, media_sha256, media_bytes, media_type. Simulated must be true; both source hashes must match, and media_type must be video/mp4. The actual MP4 travels through an independently authorized media channel with byte digest verification. Never accept arbitrary media URLs or leak secrets through model metadata.

The client checks expiry both before and after serverless routing, with a bounded two second request timeout. A slow cold worker must fail the current view gate rather than pretend to be fresh. Hosted processing requires separate server-side consent.

## Deployment gates

1. Confirm existing Vast key rights, serverless deposit and actual GPU pricing with a read-only request. No secrets in logs.
2. Independently review code and weight licenses, pinned model image, GPU memory, VAE, data processor location and erasure rules.
3. Write and validate an actual custom PyWorker and resident video model server. This PR does not contain that server and does not launch any endpoint.
4. Choose explicit zero warm minimum, one worker maximum, queue bound and stop rule. Vast defaults can retain paid workers.
5. Test with synthetic public inputs, then one authorized Spaces snapshot. Verify exact hashes and a real output clip digest.
6. Measure GPU, queue, model and display timing separately; publish distinct valid FPS and cost per accepted output.

The current service is fail closed with remote calls disabled by default. See ADR 210 and WorldGraph ADR 204.
