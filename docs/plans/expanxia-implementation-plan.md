# Implementation plan — Expanxia-style interactive 3D platform capabilities for worldgraph

- **Status:** Implemented baseline (WebSocket deployment; browser WebTransport adapter)
- **Date:** 2026-08-14
- **Relates to:** ADR-200 (WASM bridge), ADR-201 (coordinate frame), ADR-202
  (spatial applications), ADR-203 (evolution loop), ADR-204 (Rust generative
  world-model runtime)
- **Produced by:** `/plan-change` (architect step; hand to `implementer` per phase)

## 1. Goal (one sentence)

Evolve the worldgraph browser twin from a single-user, load-once WASM demo into an
Expanxia-style platform: **live multi-viewer twin streaming over QUIC/WebTransport,
runtime loading of compressed 3D assets, and a WebGPU/XR-capable render path** —
without weakening the privacy and provenance guarantees that define the project.

## 2. Reference model — what Expanxia is and what we borrow

[Expanxia](https://expanxia.com) ("Interactive 3D Everywhere") is a browser-based,
no-download platform for real-time, multi-user immersive 3D worlds: WebGPU
rendering, OpenXR support, hundreds of concurrent users as avatars in persistent
hubs, creator broadcasting, and self-hostable deployment.

Their public GitHub org ([github.com/expanxia](https://github.com/expanxia)) is a
curated set of forks that reads as a technology bill of materials:

| Expanxia fork | Capability it implies | worldgraph analog (this plan) |
|---|---|---|
| `msquic`, `nghttp3` | QUIC / HTTP-3 low-latency transport | **Phase 1** — twin delta streaming over WebTransport |
| `basis_universal`, `astc-encoder` | GPU-native compressed textures | **Phase 3** — KTX2/Basis asset pipeline |
| `glTFRuntime` | Runtime (not build-time) asset loading | **Phase 3** — `SceneBackend.loadAsset()` |
| `jsbsim` | Physics/dynamics simulation | Already present — OccWorld forecasting (`wifi-densepose-worldmodel`) is our simulation layer |

Similar open projects consulted for shape: PlayCanvas/SuperSplat (already our
render host), TerriaJS and OpenTwins (spatial digital-twin platforms — both
poll/pub-sub twin state to browsers, validating the snapshot+delta pattern).

### Decart Oasis 3 — protocol lessons, not a transport substitute

[Oasis 3 Preview](https://docs.platform.decart.ai/models/realtime/oasis-3) is a
hosted, promptable learned driving simulator: a stateful Python/gRPC session
takes chunks of exactly four throttle/steering actions and returns four
generated VP9 camera frames for each advertised view (`left_forward`, `front`,
and `right_forward`) in the same tick. It is not a structured spatial-twin
protocol and does not replace the graph-delta or browser-rendering work below.
Its session design does provide useful constraints for worldgraph:

- make the lifecycle explicit (`initialize` → stream/resume → `finish`) and
  authenticate before returning any state;
- negotiate advertised streams/capabilities rather than assuming every client
  supports the same transport or payloads;
- scope sequence numbers to a server-issued stream epoch. Oasis resets its
  sequence on a new prompt; worldgraph must likewise prevent a reconnect or
  server restart from making an old `seq` look current;
- validate bounded inputs before mutation or fan-out; and
- feed decoded messages through a consumer callback so rendering, recording,
  and testing do not depend directly on the transport implementation.

Generated frames from a learned model are predictions, not sensed graph facts.
Per ADR-204, any future Oasis-style adapter belongs behind
`wifi-densepose-worldmodel`, with
its output labelled as simulated and kept out of the authoritative
`WorldGraph` unless converted into a `SemanticState` with explicit provenance.

**What we deliberately do not borrow:** identity-bearing avatars, generated or
captured video as authoritative twin state, and monetization. worldgraph's
differentiator is *privacy-by-design* (anonymous RF tracks, mandatory
`SemanticProvenance`, queryable `PrivacyRollup`). Every phase below preserves
that invariant; the network layer must enforce it, not merely transport around
it.

## 3. Current state (what exists, verified against source)

- `wifi-densepose-worldgraph` — the typed twin (`WorldNode`/`WorldEdge`,
  `to_json`/`from_json`, schema-versioned).
- `worldgraph-wasm` — host-tested core (`core.rs`, `enu.rs`, `overlay.rs`) plus a
  thin `#[wasm_bindgen]` surface (`bridge.rs`) that already has the mutators a
  live stream needs: `upsert_person`, `remove_node`, `add_room_from_box`,
  `add_sensor_from_marker`, `export_rvf_json`.
- `supersplat-bridge` — TS layer: `SemanticVisualizer` (injected WASM module),
  `WorldgraphScene` reconciler (create/update/destroy sync), `SceneBackend`
  abstraction with a PlayCanvas reference adapter, and four use cases
  (avatars, configurator, occworld, audit).
- **Gaps vs Expanxia:** no networking of any kind (tracks are fed locally),
  single viewer, assets load once from a static RVF/JSON payload, WebGL-era
  render path, no XR, no server component.

## 4. Phases

Ordered by dependency and by value-per-risk. Each phase is independently
shippable and lands behind the existing fitness function (ADR-203), extended as
noted in §7.

---

### Phase 1 — Live twin streaming (`worldgraph-stream`)

The core Expanxia capability: state changes propagate to browsers in real time.

**Files to touch and why**

| File | Why |
|---|---|
| `worldgraph-stream/` (new crate, workspace member) | Protocol types + pure application logic, host-testable like `worldgraph-wasm/src/core.rs` |
| `worldgraph-stream/src/delta.rs` | Versioned envelope/messages + idempotent `apply_message` |
| `worldgraph-stream/src/session.rs` | Sequence numbers, snapshot request/resume logic (pure state machine, no I/O) |
| `worldgraph-stream/src/policy.rs` | Viewer claims, graph projection, and the one authorization path shared by snapshots and deltas |
| `worldgraph-stream/src/server.rs` (feature `server`) | Fan-out server: `axum` + `wtransport` (WebTransport/QUIC — the msquic analog) with WebSocket fallback |
| `wifi-densepose-worldgraph/src/model.rs` + `graph.rs` | Add stable `WorldEdgeId`, persisted edge records, and edge upsert/removal APIs required for idempotent replay |
| `Cargo.toml` (workspace) | Add member + shared deps |
| `worldgraph-wasm/src/bridge.rs` | One new method: `apply_message_json(&mut self, json: &str)` delegating to the crate |
| `supersplat-bridge/src/types.ts` + contract tests | Mirror the versioned edge-record wire format and prove v1 snapshot migration |
| `supersplat-bridge/src/stream.ts` (new) | `TwinStreamClient`: WebTransport with WebSocket fallback, ordered delta application, snapshot resync |
| `supersplat-bridge/src/index.ts` | Export the new module |

**Smallest interface that satisfies it**

```rust
// worldgraph-stream/src/delta.rs — protocol version and graph-schema version
// are deliberately independent.
#[derive(Serialize, Deserialize)]
pub struct ClientHello {
    pub supported_protocol_versions: Vec<u16>,
    pub capabilities: Vec<String>,
    pub resume: Option<ResumeCursor>,
}

#[derive(Serialize, Deserialize)]
pub struct TwinEnvelope {
    pub protocol_version: u16,
    pub stream_epoch: String, // changes whenever sequence numbering restarts
    pub seq: u64,
    pub message: TwinMessage,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum TwinMessage {
    Snapshot { graph_schema_version: u16, rvf_json: String },
    UpsertNode { node: WorldNode },
    RemoveNode { id: WorldId },
    UpsertEdge { id: WorldEdgeId, from: WorldId, to: WorldId, edge: WorldEdge },
    RemoveEdge { id: WorldEdgeId },
}

pub fn apply_message(g: &mut WorldGraph, m: &TwinMessage) -> Result<(), StreamError>;
```

```ts
// supersplat-bridge/src/stream.ts
export class TwinStreamClient {
  connect(endpoints: StreamEndpoints): Promise<NegotiatedSession>;
  onDelta(cb: (seq: number) => void): void;     // fires after viz has applied it
  close(): void;
}
// wiring: client.onDelta(() => scene.sync(viz.renderPrimitives()))
```

`StreamEndpoints` carries distinct HTTPS WebTransport and WSS fallback URLs;
the negotiated session returns the chosen protocol version, capabilities, and
`stream_epoch`. A client must discard buffered deltas when the epoch changes or
when a sequence gap forces snapshot resynchronization.
Snapshots whose `graph_schema_version` is unsupported are rejected explicitly;
they are never silently loaded as the current graph schema.

**Graph-replication invariant:** delta application is idempotent. Stable
`WorldEdgeId` gives parallel edges unambiguous replacement/removal semantics
that the current append-only `WorldGraph::add_edge` API does not provide. The
persisted graph schema gains edge records and migrates legacy edge triples by
assigning IDs deterministically in serialized order. Tests cover duplicate
delivery, parallel edges, edge metadata replacement, edge deletion,
out-of-order delivery, epoch change, and snapshot-then-tail equivalence.

**Privacy invariant (non-negotiable):** a bearer token is resolved server-side
to `ViewerClaims`; clients never supply trusted scopes themselves. One
`TwinAccessPolicy` decides `can_read_node` and `can_read_edge`. It is used both
to project the initial snapshot and to filter every later message, and an edge
is emitted only when both endpoints are visible. `SemanticProvenance` and a
computed `PrivacyRollup` are policy inputs/audit evidence, not authorization
mechanisms by themselves. `core::provenance_for` remains a display-only audit
function and is not treated as a gate. A viewer without audit scope never
receives an excluded belief or any edge that reveals it.

The browser authenticates with a short-lived, audience-bound client token
issued over HTTPS; a long-lived service/API key is never embedded in JavaScript
or placed in a stream URL. Token expiry and refresh are part of the session
state machine.

---

### Phase 2 — Multi-viewer presence (`usecases/presence.ts`)

Expanxia's "hundreds of users as avatars." For worldgraph the analog is
multiple *operators* viewing the same twin, each visible as a pseudonymous
presence marker — kept strictly distinct from sensed `PersonTrack` nodes.

**Files to touch and why**

| File | Why |
|---|---|
| `worldgraph-stream/src/presence.rs` | `PresenceUpdate { viewer_id: u64, position: EnuPoint }` messages on the same channel; viewers are ephemeral, never persisted into the twin graph |
| `supersplat-bridge/src/usecases/presence.ts` (new) | `PresenceLayer` mirroring `PersonTrackLayer`'s registry pattern (ADR-202 §1) but rendering viewer markers, not person capsules |
| `worldgraph-stream/src/server.rs` | Session join/leave, presence rebroadcast |

**Smallest interface:** `PresenceLayer.apply(updates: PresenceUpdate[])` →
primitives merged into the same `scene.sync()` pass. Viewer markers carry a
distinct semantic `kind: 'viewer_presence'` and use an existing drawable
`PrimitiveShape` such as `sphere`. `PrimitiveShape` remains the PlayCanvas mesh
type; `primitiveKey` already includes `kind`, so presence IDs cannot collide
with or be confused with sensed `person_track` entities.

**Deliberate scope cut:** no chat, no identity, no per-viewer permissions UI in
this phase — access control is a bearer token checked at `connect()`.

---

### Phase 3 — Runtime assets + compressed pipeline

The glTFRuntime / basis_universal analog: scenes and props load at runtime,
textures ship GPU-compressed (KTX2/Basis — PlayCanvas transcodes Basis
natively, so no new wasm codec is needed).

**Files to touch and why**

| File | Why |
|---|---|
| `wifi-densepose-worldgraph/src/model.rs` | Add optional `AssetRef { url, format, integrity }` metadata to `ObjectAnchor` and define its persisted-schema compatibility |
| `wifi-densepose-worldgraph/src/graph.rs` + contract tests | Bump/validate the graph schema and prove old snapshots without `asset` still deserialize |
| `supersplat-bridge/src/types.ts` | Mirror `AssetRef`; change `RenderPrimitive` into a discriminated solid/line/asset union |
| `worldgraph-wasm/src/core.rs` | Emit an asset primitive for `ObjectAnchor` nodes whose optional asset metadata is present |
| `supersplat-bridge/src/renderer.ts` | Reconciler handles async-loading primitives (placeholder box → swap on load, destroy cancels load) |
| `supersplat-bridge/src/playcanvas-adapter.ts` | `SceneBackend.loadAsset(url, format)` using PlayCanvas runtime glTF/KTX2 loaders |

**Smallest interface:** one new method on `SceneBackend`
(`loadAsset(url: string, format: AssetFormat): Promise<BackendEntity>`) plus the
one new primitive variant. The fake backend in `__tests__/fake-bridge.ts` gains
a synchronous stub so vitest coverage stays headless.

`AssetRef` is optional and uses `#[serde(default)]` so prior snapshots remain
readable, but the persisted schema version is still bumped because the wire
contract has expanded. Runtime URLs widen network permissions: the adapter
allows only configured HTTPS origins, enforces size/time limits, verifies the
optional content hash before activation, and documents required CORS/CSP. A
failed or cancelled load leaves/removes only the placeholder and never leaks a
late-resolving entity back into the scene.

---

### Phase 4 — WebGPU + XR render path

Expanxia's headline ("WebGPU… full OpenXR support"). Because ADR-200 isolated
rendering behind `SceneBackend`, this is adapter-local.

**Files to touch and why**

| File | Why |
|---|---|
| `supersplat-bridge/src/playcanvas-adapter.ts` | Accept a pre-configured graphics device; prefer WebGPU (`deviceTypes: ['webgpu', 'webgl2']`); expose `startXr()` delegating to PlayCanvas WebXR |
| `supersplat-bridge/src/types.ts` | Optional `RendererCaps { webgpu: boolean; xr: boolean }` for feature detection in use cases |

**Smallest interface:** constructor option + capability flags. No reconciler or
Rust changes. WebGL2 remains the fallback, with browser integration tests for
device-selection failure, XR user-gesture requirements, and context loss before
the path is considered non-regressing.

---

### Phase 5 — Broadcast, persistence, self-hosting, simulation (follow-on sketch)

- **Broadcast** = one producer's delta stream fanned out read-only to N viewers
  — already the Phase 1 server's shape; add stream recording (`.jsonl` of
  `TwinEnvelope`) and replay. Recording doubles as an **audit log**, compounding
  the provenance story (ADR-202 §4).
- **Persistent hubs** = server persists `Snapshot` + delta log; late joiners get
  snapshot-then-tail (Phase 1's resume path already requires this).
- **Self-hosting** = the `server` feature binary + a Dockerfile; no code beyond
  Phase 1/2.
- **Learned simulation adapter (optional)** = an Oasis-style stateful adapter
  behind `wifi-densepose-worldmodel` per ADR-204: explicit
  initialize/reset/step/finish, strict bounded actions, negotiated output
  streams, and a consumer seam for preview/recording. Generated frames remain a
  simulation side channel; only derived claims with `SemanticProvenance` may
  enter `WorldGraph`.

This phase is intentionally not specced file-by-file — it should be re-planned
after Phase 1 ships and real fan-out behavior is observed.

## 5. Sequencing and effort

| Phase | Depends on | Est. size | Ships alone? |
|---|---|---|---|
| 1 — twin streaming | — | XL (graph schema + protocol + policy + server + TS client) | Yes — demo: two browsers, one moving track |
| 2 — presence | 1 | M | Yes |
| 3 — runtime assets | — (parallel with 1) | L (model/schema + async renderer + network policy) | Yes |
| 4 — WebGPU/XR | — (parallel) | S | Yes |
| 5 — broadcast/persist | 1, 2 | L | Re-plan first |

## 6. Ripple / permission flags (plan-change step 4)

- **Phase 1 ripples beyond three files** (new crate, graph edge APIs, workspace
  manifest, wasm bridge, TS client, exports) — it is the smallest honest cut
  for exact, authorized replication; the envelope + `apply_message` + policy
  projection are the choke points that keep transport adapters thin.
- **Phase 1 widens a permission:** the `server` feature opens a network
  listener and adds `axum`/`wtransport` dependencies. It is feature-gated so
  library consumers and the WASM build never pull it in. **Needs explicit user
  sign-off before implementation.**
- **Privacy surface widens:** twin state leaves the machine for the first time.
  The server-side privacy filter (Phase 1) must land in the same PR as fan-out,
  with tests proving an excluded belief never crosses the wire.
- **Phase 3 widens a permission:** runtime assets introduce browser network
  egress and untrusted payload parsing. The origin allowlist, CORS/CSP, resource
  limits, integrity verification, cancellation, and schema changes ship with
  the loader.
- Phase 4 stays within the existing rendering seam, but WebGPU/XR fallback and
  user-gesture requirements still need browser integration tests.

## 7. Fitness extensions (ADR-203)

Each phase adds selection pressure before it can merge:

1. **Delta round-trip:** `apply_message(from_json(snapshot), messages…)` ≡ the
   graph that produced them; property-tested over generated node and edge
   mutations, duplicate delivery, removal, reconnects, and epoch changes.
2. **Privacy fan-out test:** a graph with a privacy-limited belief, two mock
   viewers with different server-resolved claims → byte-level assertion the
   limited node and all incident edges are absent from both the restricted
   viewer's snapshot and its delta stream.
3. **TS/Rust parity** (extends fitness #4): delta application in
   `TwinStreamClient` (via the wasm bridge) and native `apply_message` produce
   identical `render_primitives` output for the same delta log.
4. **Reconciler perf:** `scene.sync` frame cost under N=200 moving
   tracks/presences — the pre-existing "next generation" benchmark from
   ADR-203 becomes mandatory once multi-viewer load is real.
5. Existing gates unchanged: `cargo test` all crates, `tsc --noEmit` strict,
   `vitest run`, workspace `unsafe_code = "forbid"`, no new warnings.

## 8. Resolved implementation choices

1. The browser has a bounded reliable WebTransport adapter with automatic
   WebSocket fallback. The shipped Rust server and container use WebSocket;
   native HTTP/3 certificate/runtime management remains an edge deployment
   concern rather than a requirement for the first self-hosted artifact.
2. Viewer presence is strictly ephemeral, server-pseudonymized, and never
   written to RVF/JSON.
3. Runtime assets support glTF/GLB plus integrity and origin policy. Splat
   conversion/compression remains outside this bridge.
4. The provider-neutral action-in/frame-out session is implemented in
   `wifi-densepose-worldmodel` with deterministic mock and external Unix-sidecar
   providers. Generated media remains separate from authoritative graph state.

## 9. Implementation record

The baseline includes schema-v2 stable edge records with deterministic v1
migration, replay-safe epoch/sequence handling, privacy-filtered fan-out,
authenticated producer ingest, token refresh/expiry, multi-viewer presence,
WASM message application, cancellable runtime assets, WebGPU/WebGL2 selection,
WebXR delegation, ADR-204 provider sessions, and a hardened container manifest.
CI runs strict all-feature Rust Clippy/tests, browser typecheck/tests/build, and
a non-publishing container build.
