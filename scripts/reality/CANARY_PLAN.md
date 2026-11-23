# Vast.ai Reality canary admission

**Review only. This procedure cannot create or run a serverless endpoint.** The `vast_canary_plan.py` program validates explicit configuration fields and prints a local report. Its `ok` flag means syntactic and policy compliance only. It does not establish a genuine operator approval, quote, entitlement, licensed checkpoint, watchdog, or valid data processing agreement.

## Audit the unapproved example

Run from the WorldGraph root:

```bash
python3 scripts/reality/vast_canary_plan.py scripts/reality/examples/vast_canary_unapproved.json
```

The example is intentionally blocked: the worker image and checkpoint digests are placeholders, the model license and current quote have not been reviewed, the GPU spend and hosted data approvals are absent, and no shutdown watchdog is verified. The expected command exit is 2. No billing or networking occurs.

## Vast-specific controls

Vast Serverless supports an endpoint, a worker group, and a PyWorker proxy beside a separately hosted video model server. Its API documents a default `cold_workers=5` and `max_workers=20`. A canary configuration must explicitly use `min_load=0`, `min_cold_load=0`, `cold_workers=0`, `max_workers=1`, a positive `inactivity_timeout`, bounded queue time, and a stopped initial state. These settings allow scaling down; they do not by themselves cap all provider charges or guarantee a warm latency SLA.

The proposed client route `/v1/reality/render` is **our custom backend contract**, not a built-in Vast video inference endpoint. The GPU owner must implement its request verification and actual signed media output in a separate PR. Do not call deployment, template creation, worker creation or `ensure_ready()` from this tool.

## Operator's separate acceptance receipts

1. A live, nonsecret cost quote with the selected GPU SKU, worker storage and estimated warm/cold billing.
2. Immutable PyWorker source commit and model image and weights SHA256; component licensing and data processor approval.
3. An external watchdog verified to stop billable workers when the authorized spend/time limit is hit, including failed inference.
4. An authorized server-side identity and snapshot validation mechanism. Self-computed SHA256 manifests do not authenticate a request.
5. A positive remote smoke run only after cost and data processing approval, with a real MP4 byte digest, measured end-to-end latency and independent scene geometry checks.

Even with all fields populated, the audit code does not authorize creation or spending. Only the designated human/operator approval workflow can do that.

Primary documentation: https://github.com/vast-ai/docs/blob/main/api-reference/openapi.yaml and https://github.com/vast-ai/docs/blob/main/guides/serverless/managing-scale.mdx
