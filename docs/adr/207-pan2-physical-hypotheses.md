# ADR 207: PAN2 physical hypotheses in WorldGraph

Status: implemented protocol and graph integration; live GPU generation pending.

## Decision

Extend the existing worldmodel runtime with `ExternalModelKind::Pan2`. Add a
separate structured physical-response protocol and local Unix bridge. Keep the
authoritative observed graph immutable. Materialize predictions only in an
explicit copy as provenance-bearing `physical_hypothesis` semantic nodes.
No track positions, observed events, collision geometry or control commands are
updated from generated predictions. Hypothesis confidence is zero until a future
independent calibration mechanism exists.

PAN2 is a video/latent world model, not a numeric physics solver. A separately
installed, calibrated extractor must turn its output into metric trajectories.
The implementation here neither provides that extractor nor claims that reading
PAN2 latents alone yields registered positions. Raw video is not required by the
WorldGraph protocol. Exact forces, accelerations, contacts and rigid-body dynamics
are outside this integration.

## Pipeline and invariants

1. Caller applies a privacy decision, selects at most 64 track nodes and supplies
   calibrated ENU bounds, up to 128 occupied boxes, an action and a horizon of at
   most 20 seconds. Projection includes positions and authorized local IDs only;
   names, embeddings and raw sensor frames are excluded. Action text and context
   remain caller-controlled and must not contain private information beyond scope.
2. Preparation hashes the full source graph locally and the authorized request
   separately. Only the projected request crosses the Unix socket. Hashes provide
   content binding, not authentication or proof of authorized data handling.
3. A separate PAN2 worker emits the response below with a model-manifest hash,
   generated-artifact hash, extractor version, matching frame/calibration and
   request hash. `execution` explicitly distinguishes `fixture` from `pan2`.
   These are executor assertions, not verified execution attestations.
4. Validation rejects foreign tracks, duplicate tracks/ticks, stale requests,
   unregistered coordinates, nonfinite positions, speed violations, out-of-bounds
   positions and segments intersecting occupied boxes. Segment checks prevent
   tunnelling between sampled positions. This is a point-path geometric filter,
   not a body-volume collision or conservation-law validator. Empty obstacles
   means no obstacle geometry supplied, not a guarantee of clear space.
5. Branch creation requires the original graph hash. It returns a COPY with
   hypothesis nodes and `derived_from` edges, leaving measured tracks unchanged.
   Branches stay in the simulation context; do not publish them as sensor truth.
6. Later sensor samples must match every predicted track/tick and the original
   frame, time and calibration. Reconciliation reports point-position RMSE and a
   stationary baseline. There is no automatic promotion or actuator interface.

## Wire and deployment

`Pan2PhysicalBridge` uses a separate local socket, not the generic media-sidecar
socket. Each request/response is one newline-terminated JSON object, capped at
256 KiB before parsing. Deadline and cancellation wrap the entire exchange.
Socket permissions and a trusted local executor are required; there is no TCP
listener, shell execution, file download or credential field in a request.
No request string is interpreted as a command or local file path.

Request JSON is emitted by the `prepare` example, and its SHA256 is computed over
compact `serde_json` serialization of `Pan2PhysicalRequest` in field order. For
cross-language workers, hash the exact received JSON bytes excluding the newline,
not a differently formatted reserialization. The projection digest is generated
by Rust. Do not substitute the projection digest for the request digest.

Response example (replace all hashes with the exact executor-owned values):

```json
{
  "schema_version": 1,
  "request_sha256": "64-lowercase-hex-characters",
  "model_sha256": "64-lowercase-hex-characters",
  "artifact_sha256": "64-lowercase-hex-characters",
  "extractor_version": "calibrated-extractor/1",
  "frame_id": "room-enu",
  "calibration_id": "survey-1",
  "execution": "pan2",
  "trajectories": [{"track_id": 7, "points": [
    {"offset_ms": 1000, "position_m": [1.0, 0.0, 1.0]}
  ]}]
}
```

```sh
cargo run -p wifi-densepose-worldmodel --example pan2_physical -- \
  prepare graph.json context.json ids.json
cargo run -p wifi-densepose-worldmodel --example pan2_physical -- \
  replay graph.json context.json ids.json response.json observations.json
cargo run -p wifi-densepose-worldmodel --example pan2_physical -- \
  live graph.json context.json ids.json /run/user/1000/pan2-physical.sock /models/PAN2 --terms-accepted
cargo test -p wifi-densepose-worldmodel --test pan2_physical --locked
```

The model configuration requires explicit terms acceptance and an existing local
weights path, as with other external providers. It does not prove weights are
complete or loadable. PAN2's own backbone is Apache-2.0; text encoder, VAE and
extractor dependencies require separate operator review. No model is bundled,
downloaded, started, uploaded or billed by this change.

## Acceptance and remaining evidence

Protocol E2E uses a real Unix socket with an explicitly labeled synthetic worker:
graph projection, wire request, response validation, hypothesis graph roundtrip,
and reconciliation with separate fixture observations. Tests cover immutable
observations, redacted embeddings, malformed/stale responses, collision tunnelling,
limits, cancellation, timeout and provider admission.

Full live acceptance additionally requires a CUDA executor, pinned model and
extractor, actual generated artifacts with independently verified hashes,
calibration against real sensor observations, and 100 unseen recorded scenarios.
Compare RMSE, failure rate and total latency against stationary and constant
velocity baselines. Fixture accuracy is not model accuracy. No PAN2 throughput,
physical correctness or RuView improvement is established by protocol tests.

This Rust API has no UI changes and does not alter RuLab's renderer. Existing
WorldGraph snapshots remain schema v2. Rollback removes the new module/provider
selection; authoritative snapshots require no migration.

References: [PAN2 model card](https://github.com/ifm-ai/PAN2/blob/main/MODEL_CARD.md),
[Rust checkpoint work](https://github.com/ruvnet/ruv-FANN/pull/228).
