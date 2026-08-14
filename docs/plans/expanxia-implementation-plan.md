# Implementation plan — Expanxia-style interactive 3D platform capabilities for worldgraph

- **Status:** Proposed (plan only — no code in this change)
- **Date:** 2026-08-14
- **Relates to:** ADR-200 (WASM bridge), ADR-201 (coordinate frame), ADR-202 (spatial applications), ADR-203 (evolution loop)
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

**What we deliberately do not borrow:** identity-bearing avatars, video
broadcast, and monetization. worldgraph's differentiator is *privacy-by-design*
(anonymous RF tracks, mandatory `SemanticProvenance`, queryable
`PrivacyRollup`). Every phase below preserves that invariant; the network layer
must enforce it, not merely transport around it.

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
| `worldgraph-stream/src/delta.rs` | `TwinDelta` enum + `apply_delta` |
| `worldgraph-stream/src/session.rs` | Sequence numbers, snapshot request/resume logic (pure state machine, no I/O) |
| `worldgraph-stream/src/server.rs` (feature `server`) | Fan-out server: `axum` + `wtransport` (WebTransport/QUIC — the msquic analog) with WebSocket fallback |
| `Cargo.toml` (workspace) | Add member + shared deps |
| `worldgraph-wasm/src/bridge.rs` | One new method: `apply_delta_json(&mut self, json: &str)` delegating to the crate |
| `supersplat-bridge/src/stream.ts` (new) | `TwinStreamClient`: WebTransport with WebSocket fallback, ordered delta application, snapshot resync |
| `supersplat-bridge/src/index.ts` | Export the new module |

**Smallest interface that satisfies it**

```rust
// worldgraph-stream/src/delta.rs — schema-versioned like the RVF payload
#[derive(Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum TwinDelta {
    Snapshot { seq: u64, rvf_json: String },
    UpsertNode { seq: u64, node: WorldNode },
    RemoveNode { seq: u64, id: WorldId },
    UpsertEdge { seq: u64, from: WorldId, to: WorldId, edge: WorldEdge },
}

pub fn apply_delta(g: &mut WorldGraph, d: &TwinDelta) -> Result<(), StreamError>;
```

```ts
// supersplat-bridge/src/stream.ts
export class TwinStreamClient {
  connect(url: string): Promise<void>;          // WebTransport, falls back to WebSocket
  onDelta(cb: (seq: number) => void): void;     // fires after viz has applied it
  close(): void;
}
// wiring: client.onDelta(() => scene.sync(viz.renderPrimitives()))
```

**Privacy invariant (non-negotiable):** the server filters deltas through the
node's `SemanticProvenance` privacy decision / `PrivacyRollup` *before* fan-out.
A viewer without audit scope never receives a belief its privacy posture
excludes — enforcement is server-side, mirroring how `provenance_for` already
gates the client.

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
distinct `PrimitiveShape` so they can never be confused with sensed people.

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
| `supersplat-bridge/src/types.ts` | Add `asset` variant to the render-primitive union: `{ kind: 'asset', url, format: 'gltf' \| 'splat', transform }` |
| `worldgraph-wasm/src/core.rs` | Emit an asset primitive for `ObjectAnchor` nodes that carry an asset URL (extend `primitive_for`) |
| `supersplat-bridge/src/renderer.ts` | Reconciler handles async-loading primitives (placeholder box → swap on load, destroy cancels load) |
| `supersplat-bridge/src/playcanvas-adapter.ts` | `SceneBackend.loadAsset(url, format)` using PlayCanvas runtime glTF/KTX2 loaders |

**Smallest interface:** one new method on `SceneBackend`
(`loadAsset(url: string, format: AssetFormat): Promise<BackendEntity>`) plus the
one new primitive variant. The fake backend in `__tests__/fake-bridge.ts` gains
a synchronous stub so vitest coverage stays headless.

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
Rust changes. Fallback to WebGL2 is automatic, so this cannot regress existing
deployments.

---

### Phase 5 — Broadcast, persistence, self-hosting (follow-on, sketch only)

- **Broadcast** = one producer's delta stream fanned out read-only to N viewers
  — already the Phase 1 server's shape; add stream recording (`.jsonl` of
  `TwinDelta`) and replay. Recording doubles as an **audit log**, compounding
  the provenance story (ADR-202 §4).
- **Persistent hubs** = server persists `Snapshot` + delta log; late joiners get
  snapshot-then-tail (Phase 1's resume path already requires this).
- **Self-hosting** = the `server` feature binary + a Dockerfile; no code beyond
  Phase 1/2.

This phase is intentionally not specced file-by-file — it should be re-planned
after Phase 1 ships and real fan-out behavior is observed.

## 5. Sequencing and effort

| Phase | Depends on | Est. size | Ships alone? |
|---|---|---|---|
| 1 — twin streaming | — | L (new crate + server + TS client) | Yes — demo: two browsers, one moving track |
| 2 — presence | 1 | M | Yes |
| 3 — runtime assets | — (parallel with 1) | M | Yes |
| 4 — WebGPU/XR | — (parallel) | S | Yes |
| 5 — broadcast/persist | 1, 2 | L | Re-plan first |

## 6. Ripple / permission flags (plan-change step 4)

- **Phase 1 ripples beyond three files** (new crate, workspace manifest, wasm
  bridge, TS client, exports) — it is the smallest honest cut for the
  capability; the delta enum + `apply_delta` is the choke point that keeps the
  rest thin.
- **Phase 1 widens a permission:** the `server` feature opens a network
  listener and adds `axum`/`wtransport` dependencies. It is feature-gated so
  library consumers and the WASM build never pull it in. **Needs explicit user
  sign-off before implementation.**
- **Privacy surface widens:** twin state leaves the machine for the first time.
  The server-side privacy filter (Phase 1) must land in the same PR as fan-out,
  with tests proving an excluded belief never crosses the wire.
- Phases 3–4 stay within the existing `SceneBackend` seam — no permission
  changes, ≤4 files each.

## 7. Fitness extensions (ADR-203)

Each phase adds selection pressure before it can merge:

1. **Delta round-trip:** `apply_delta(from_json(snapshot), deltas…)` ≡ the
   graph that produced them; property-tested over generated mutations.
2. **Privacy fan-out test:** a graph with a privacy-limited belief, two mock
   viewers with different scopes → byte-level assertion the limited node is
   absent from the restricted viewer's stream.
3. **TS/Rust parity** (extends fitness #4): delta application in
   `TwinStreamClient` (via the wasm bridge) and native `apply_delta` produce
   identical `render_primitives` output for the same delta log.
4. **Reconciler perf:** `scene.sync` frame cost under N=200 moving
   tracks/presences — the pre-existing "next generation" benchmark from
   ADR-203 becomes mandatory once multi-viewer load is real.
5. Existing gates unchanged: `cargo test` all crates, `tsc --noEmit` strict,
   `vitest run`, workspace `unsafe_code = "forbid"`, no new warnings.

## 8. Open questions for the user

1. Transport: is WebTransport-first (with WebSocket fallback) acceptable, or is
   WebSocket-only preferred for the first cut? (WebTransport needs an HTTP/3
   capable deployment; the fallback keeps GitHub Pages demos working.)
2. Should viewer presence (Phase 2) be visible in the exported RVF/JSON at all,
   or strictly ephemeral? (Plan assumes strictly ephemeral.)
3. Any appetite for adopting Expanxia's compressed-splat direction (e.g. SOG or
   `.ply`→compressed conversion) in Phase 3, or keep splat loading as-is and
   compress only textures?
