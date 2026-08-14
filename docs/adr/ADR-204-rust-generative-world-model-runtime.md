# ADR-204 — Rust control plane for generative world-model runtimes

- **Status:** Accepted
- **Date:** 2026-08-14
- **Relates to:** ADR-147 (OccWorld bridge), ADR-200 (WASM bridge), ADR-202
  (spatial applications), ADR-203 (verification-driven evolution)

## Context

worldgraph may use learned video world models to render hypothetical futures,
interactive simulations, synthetic data, or operator previews. Candidate
providers have materially different deployment and licensing properties:

- [Decart Oasis 3](https://docs.platform.decart.ai/models/realtime/oasis-3) is a
  hosted, stateful action-to-video service.
- [LingBot-World v2](https://github.com/Robbyant/lingbot-world-v2) is an
  action/camera-conditioned causal video model whose released code and weights
  are CC BY-NC-SA 4.0 and therefore non-commercial.
- [Wan2.2](https://github.com/Wan-Video/Wan2.2) is an Apache-2.0
  video-generation foundation with a smaller 5B option, but its released
  pipelines are asynchronous generators rather than live interactive
  simulators.

The current `wifi-densepose-worldmodel::OccWorldBridge` is deliberately thin:
one newline-delimited JSON request/response over a Unix socket with a timeout.
It proves that Rust can own the domain contract while a Python process owns GPU
inference, but its one-shot occupancy response is not sufficient for a
stateful, long-running frame stream.

A direct port of the models is possible but is not a small translation. The
runtime includes a text encoder, video VAE, diffusion transformer/MoE, causal
attention and KV caches, camera conditioning, schedulers, multi-GPU sharding,
FlashAttention, and video codecs. Rewriting Python orchestration in Rust would
still execute CUDA/C++ kernels. It would also not change the license of copied
code or weights.

The architecture must preserve worldgraph's stronger invariant: sensed graph
state is authoritative; generated pixels are explicitly simulated output.

## Decision

### 1. Keep authority and simulation separate

`WorldGraph` and its versioned `TwinEnvelope` remain the source of truth.
Generated frames travel on a separate `SimulatedFrameEnvelope`; they are never
encoded as graph deltas and never mutate the graph implicitly.

A model-derived claim may enter `WorldGraph` only as a `SemanticState` with
explicit provenance identifying at least:

- provider, model/checkpoint, and runtime version;
- source snapshot hash and stream epoch;
- prompt/action hash, seed, and generation sequence;
- simulated status, confidence, and privacy decision.

### 2. Put the stable session contract in Rust

Add a provider-neutral session API to `wifi-densepose-worldmodel`:

```rust
pub trait GenerativeWorldModel {
    async fn initialize(&self, seed: SceneSeed) -> Result<ModelSession, WorldModelError>;
    async fn step(
        &self,
        session: &ModelSession,
        action: ActionChunk,
    ) -> Result<SimulatedFrameChunk, WorldModelError>;
    async fn reset(
        &self,
        session: &ModelSession,
        seed: SceneSeed,
    ) -> Result<ModelSession, WorldModelError>;
    async fn finish(&self, session: ModelSession) -> Result<(), WorldModelError>;
}
```

The concrete API may use boxed futures or an async-trait helper as required by
the supported Rust toolchain. The contract, not that syntax, is normative.

Rust owns session epochs and sequence validation, authentication, privacy
projection, bounded inputs, deadlines, cancellation, backpressure, provider
health, resource quotas, and provenance. Frame bytes may use shared memory,
WebRTC, or another bounded binary channel; they do not pass through the current
newline-delimited JSON response buffer.

### 3. Treat accelerator runtimes as replaceable providers

Adopt providers in this order:

1. **Mock provider** — deterministic frames and failures for protocol tests.
2. **External GPU provider** — Python/SGLang/FlashDreams or a hosted API behind
   the Rust session contract. This is the first functional integration.
3. **TensorRT/CUDA provider** — compiled engines with Rust-owned scheduling when
   deployment cost or latency justifies it.
4. **[Candle](https://github.com/huggingface/candle) provider** — incremental
   native Rust implementation, beginning with Wan2.2 TI2V-5B and gated by
   numerical and performance parity.

No generative model runtime is linked into `worldgraph-wasm` or downloaded by
the browser. CUDA provider dependencies remain optional and server-only.

### 4. Make licensing an enforceable provider property

- Wan2.2's Apache-2.0 code and weights may be used by a production provider,
  subject to its notices and use requirements.
- LingBot-World v2 is an opt-in, non-commercial research provider. Its code or
  weights are not bundled in default artifacts, containers, or downloads.
- Commercial LingBot deployment requires a separate license from its rights
  holder. Reimplementing or porting the released code does not remove its
  license obligations; using the released weights remains non-commercial.
- Every provider declares a machine-readable `LicensePolicy`; release builds
  and deployment manifests reject research-only providers unless explicitly
  enabled for an eligible environment.

This is an engineering policy, not a substitute for legal review.

### 5. Apply privacy before inference and at egress

The server constructs `SceneSeed` from the caller's authorized projection. It
does not send raw RF evidence, re-identification embeddings, hidden nodes, or
unredacted audit data to a provider. Hosted providers require an explicit data
processing decision; local providers do not bypass input or retention policy.

Generated media is treated as untrusted and potentially sensitive. It carries
retention metadata, is subject to output filtering, and cannot be interpreted
as evidence merely because it resembles the sensed space.

### 6. Require measurable parity before moving kernels to Rust

A native provider is selected only after it passes fixed-fixture comparisons
against the reference runtime:

- tensor shapes, dtypes, and named-weight coverage;
- scheduler and camera-conditioning parity;
- seeded latent/output error tolerances at each stage;
- session reset, duplicate action, gap, cancellation, and crash recovery;
- peak VRAM, action-to-first-frame latency, sustained frame rate, and drift;
- identical provenance and privacy behavior across providers.

Porting proceeds component by component. A full Rust rewrite is not a release
goal until the hybrid provider demonstrates a concrete operational bottleneck
that the rewrite is expected to remove.

## Consequences

- The product-facing API, safety checks, and lifecycle are Rust-native now,
  without waiting for a risky model rewrite.
- Oasis, LingBot, Wan2.2, TensorRT, and future runtimes can be compared behind
  one contract without contaminating graph replication or the browser bridge.
- Production builds can use Apache-compatible providers while research builds
  evaluate non-commercial models without accidental redistribution.
- A Candle port remains viable and testable, but it is an optimization project
  with explicit selection pressure rather than a prerequisite for simulation.
- The system gains another server process/protocol boundary initially, plus
  operational work for GPU health, media transport, cancellation, and quotas.

## Rejected alternatives

- **Port LingBot/Wan completely before integration:** delays user value and
  duplicates rapidly changing GPU runtime work before requirements stabilize.
- **Embed generated frames in `TwinEnvelope`:** couples high-bandwidth media to
  authoritative graph ordering and weakens the sensed/simulated boundary.
- **Treat a Rust rewrite as a license workaround:** copyright and weight terms
  do not disappear when implementation language changes.
- **Send the full graph to every model provider:** violates least disclosure
  and makes hosted inference a new uncontrolled privacy boundary.
