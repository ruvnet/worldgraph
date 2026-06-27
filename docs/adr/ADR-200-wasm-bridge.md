# ADR-200 — WorldGraph ⇄ SuperSplat WebAssembly bridge

- **Status:** Accepted
- **Date:** 2026-06-27
- **Crates/Packages:** `worldgraph-wasm` (Rust), `@worldgraph/supersplat-bridge` (TypeScript)
- **Supersedes / relates to:** ADR-139 (WorldGraph model), ADR-044 (ENU frame), ADR-147 (OccWorld worldmodel)

## Context

`wifi-densepose-worldgraph` is a typed `petgraph` digital twin (rooms, sensors,
person-tracks, semantic beliefs) that runs natively. [SuperSplat][supersplat] is
a browser **PlayCanvas / WebGPU** Gaussian-splat viewer/editor written in
TypeScript. We want to render the semantic graph *over* a photorealistic splat —
in the browser, with no backend server.

Both halves already run in a browser if we cross one boundary: Rust → WASM. The
question is *how thin* that boundary should be and *what wire contract* it
speaks.

### The trap we avoided

The original integration sketch invented an API that does not exist in this
codebase: nodes keyed by `type` (`"Room"`), points as `{east,north,up}`, bounds
as `{center,size}`. The **actual** serde representation is different and is the
contract that matters:

| Sketch (wrong)            | Real serde wire format (`model.rs`)                          |
|---------------------------|--------------------------------------------------------------|
| `node.type === "Room"`    | `node.kind === "room"` (`#[serde(tag="kind", snake_case)]`)  |
| `node.ZoneBoundsEnu`      | `node.bounds_enu` (`{ shape: "rectangle", min_e, … }`)       |
| `{ east, north, up }`     | `{ east_m, north_m, up_m }`                                   |
| `WorldGraph.from_json(&str)` | `from_json(&[u8]) -> Result<…>`, needs a `GeoRegistration` |
| `graph.node_weights()` (public) | not public — `snapshot()`/`to_json()` is the read path  |

Building against the sketch would compile and then render nothing. **The bridge
is defined against the real types, and native tests pin that contract.**

## Decision

A two-layer bridge with the logic on the *testable* side of the WASM boundary.

```
┌──────────────────────────── browser ────────────────────────────┐
│  SuperSplat (PlayCanvas app)                                     │
│    └ @worldgraph/supersplat-bridge (TS)                          │
│        SemanticVisualizer ─ WorldgraphScene ─ 4 use-case modules │
│            │ (typed wire format mirrors serde exactly)           │
│            ▼                                                      │
│   worldgraph_wasm.js  ← wasm-pack --target web                   │
│            │                                                      │
│   worldgraph-wasm (Rust → wasm32)                                │
│     bridge.rs   #[wasm_bindgen]  (wasm32-only, thin serializer)  │
│        │ calls                                                   │
│     core.rs / enu.rs / overlay.rs  (PURE, host-tested)           │
│        │ wraps                                                   │
│     wifi-densepose-worldgraph::WorldGraph                        │
└──────────────────────────────────────────────────────────────────┘
```

1. **`worldgraph-wasm` Rust crate** — `crate-type = ["cdylib", "rlib"]`.
   - `cdylib` → the `.wasm` module via `wasm-pack`.
   - `rlib` → the same logic is importable by native `cargo test`.
   - `wasm-bindgen`, `serde-wasm-bindgen`, `js-sys`, `console_error_panic_hook`
     are **`wasm32`-target-only** dependencies. A native `cargo build`/`cargo
     test` never pulls the browser runtime.
   - `bridge.rs` is `#[cfg(target_arch = "wasm32")]` and contains **no logic** —
     it only marshals values across the JS boundary. Everything it calls lives
     in `core` / `enu` / `overlay`, which compile and run on the host.

2. **`@worldgraph/supersplat-bridge` TypeScript package** — declares the serde
   wire format as TS types (`types.ts`), wraps the generated module
   (`SemanticVisualizer`), reconciles primitives into the scene (`renderer.ts`),
   and ships the four spatial applications (ADR-202). The WASM module is
   *injected*, so the package type-checks and unit-tests without a browser or a
   built `.wasm`.

### Wire contract

The bridge serializes with `serde_wasm_bindgen::Serializer::json_compatible()`
so `WorldId`/`track_id` (Rust `u64`) cross as JS `number` (not `BigInt`) and
structs cross as plain objects (not `Map`) — matching the declared TS types.

Read path is the deterministic snapshot: `WorldGraph::to_json()` → parse →
typed `Vec<WorldNode>` / `Vec<(WorldId,WorldId,WorldEdge)>`. We do **not** reach
into petgraph internals; the snapshot is the supported, version-stamped surface.

## Consequences

- **The contract is enforced by tests, not eyeballs.** 14 native Rust tests +
  18 TS tests pin node filtering, render geometry, the ENU mapping, provenance
  cards, configurator round-trips, and the scene reconciler — all without a
  headless browser. A field-name drift in `model.rs` breaks a native test.
- **No backend.** Everything runs in the tab.
- **The WASM build needs `wasm32-unknown-unknown` + `wasm-pack`** (a host that
  has them runs `worldgraph-wasm/build-wasm.sh`). The CI host here lacks the
  target; the native `rlib` path is what proves correctness in-repo.
- **`bridge.rs` is intentionally untested in isolation** — it has no branches
  worth testing; all behaviour is in the host-tested core.

[supersplat]: https://github.com/playcanvas/supersplat
