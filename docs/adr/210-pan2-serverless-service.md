# ADR 210: PAN2 generation as a serverless service for the Spaces API

Status: proposed. The Vast serverless worker is implemented and was verified end to end on 2026-11-12. The GCP gateway, job API, storage and quotas are not built. Nothing here is deployed to production.

## Context

PAN2 produces the simulated rollouts that ADR 208 publishes to Cognitum Spaces. The model needs 17 to 58 GB of GPU memory depending on precision, takes minutes to start, and is only needed in bursts. The intended product is a service inside the Spaces API at cognitum.one, with GCP hosting the API and Vast serverless hosting the GPU workers.

## Decision

1. **Clients never call Vast.** The Spaces API authenticates the caller and Space, validates and caps the request, and forwards to the Vast endpoint using a key held in Secret Manager. The Vast key and route protocol are never exposed.
2. **Async jobs.** A cold start takes about 4 minutes, so the API returns a job id and the clip is stored and linked to the Space when done. Identical prompt, seed and settings give a byte identical clip, so completed jobs can be cached by their SHA-256.
3. **Labelled output.** Every clip is stored as simulated and not a measurement, with `quality_validation: pending` until ADR 209's evaluation passes for the precision in use.
4. **One worker group per precision**, scale to zero, one worker maximum until demand justifies more. INT8 with SDPA attention is the only configuration with passing evidence today.
5. **Worker contract.** A long lived model server (`pan2kit.serve`) runs every request through the upstream generation and video writing path and enforces caps (9 frames, 256x448, 4 steps by default). Vast's PyWorker proxies to it. The PyWorker is Python because Vast's worker SDK is Python; this is an exception to the Rust only rule. The route client for the gateway will be Rust.
6. **Fail closed on cost.** Per organization rate and spend limits are required before any production use. A teardown guard that deletes endpoints must be explicit about what it deletes and when.

## Evidence (RTX 5090, INT8, SDPA, 2026-11-12)

| Measurement | Result |
| :--- | :--- |
| First worker start (environment, about 87 GB weights, model load, benchmark) | about 10 minutes, about $3.40 of download billed by the host |
| Warm request, smoke size | 31 to 56 s |
| Idle to stop (timeout 300 s) | worker stopped 367 s after the last request |
| Cold restart of a stopped worker | 229 s total, 198 s waiting, 31 s generating, no re-download |
| Repeat requests | byte identical clips |
| Deleting a worker group | its instance was destroyed within 15 s |
| GPU memory at smoke size | 31.8 GB of 32 GB, so larger sizes may not fit INT8 |
| Cost while warm | about $0.8 to $1.05 per hour |

Generated clips at the smoke size are visually poor (ADR 209), so no quality claim is made for the service.

## Failures found and fixed

- **False ready signal.** Setup ran the kit's unit tests, which print the server's ready line. With one shared log the proxy treated that as a loaded model, benchmarked a server that was not up, and the autoscaler restarted the worker during the download. Setup output now has its own log, a lock allows one model process per boot, and failed setup steps stop the script.
- **Teardown guard.** A time limited guard deleted the endpoint, worker group and all instances when its limit expired. Recreating the endpoint costs a fresh worker and download. Guards must be scoped, logged and visible to the operator.
- **Host loss.** A rented instance can disappear with its logs. Long runs must write results off the instance.

## Consequences

- Cold start and download costs make a warm worker a product decision, not an implementation detail.
- The `api` repository has no automatic deploy (api#39); verify the live revision after any change.
- Production Spaces writes need a `spaces:simulate` key and explicit approval.

## Open items

| Item | Status |
| :--- | :--- |
| Gateway, job store, quotas, caching | not started |
| Rust route client and request schema | not started |
| Precision for production (group-wise INT4 vs INT8) | waiting on the GPU sweep in ADR 209 |
| Larger frame sizes and step counts | untested; INT8 memory headroom is near zero |
| Rotate and scope Vast keys for production | not started |

See [ADR 208](208-pan2-simulated-rollout-provider.md) and [ADR 209](209-pan2-quantization-metaharness.md). Worker code: `tools/pan2-vast/serverless`.
