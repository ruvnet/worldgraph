# WorldGraph × SuperSplat — WASM integration

Render the **WorldGraph** privacy-aware semantic twin over a **SuperSplat**
Gaussian splat, in the browser, with no backend. This document is the wiring
guide; the design rationale is in [`docs/adr/ADR-200..203`](docs/adr/).

> ⚠️ **Read this first.** Early integration sketches used field names that do not
> exist in this codebase (`node.type`, `ZoneBoundsEnu`, `{east,north,up}`). The
> real serde wire format is `node.kind`, `node.bounds_enu` (`{shape,…}`), and
> `EnuPoint{east_m,north_m,up_m}`. Everything below targets the **real** types,
> and the tests pin that contract. See ADR-200 for the full mapping table.

## Layout

```
worldgraph-wasm/          Rust → WASM bridge (cdylib + rlib)
  src/enu.rs              ENU ⇄ PlayCanvas mapping (ADR-201)
  src/core.rs             pure, host-tested: filtering, render geometry, provenance, configurator
  src/overlay.rs          OccWorld predictive-trajectory primitives
  src/bridge.rs           #[wasm_bindgen] surface (wasm32-only, thin)
  build-wasm.sh           wasm-pack build helper

supersplat-bridge/        TypeScript / PlayCanvas integration
  src/types.ts            serde wire format, exactly
  src/enu.ts              client-side mapping mirror
  src/wasm-bridge.ts      SemanticVisualizer (module is injected → testable)
  src/renderer.ts         WorldgraphScene reconciler (create/update/destroy)
  src/playcanvas-adapter.ts  reference SceneBackend on the pc namespace
  src/usecases/           the four spatial apps (avatars, configurator, occworld, audit)
```

## Build

### 1. Compile the bridge to WASM (host needs the wasm target + wasm-pack)

```bash
rustup target add wasm32-unknown-unknown      # once
cargo install wasm-pack                        # once
cd worldgraph-wasm && ./build-wasm.sh          # → ../supersplat-bridge/src/worldgraph-wasm/
```

This emits `worldgraph_wasm.js` + `worldgraph_wasm_bg.wasm` + `.d.ts` into
`supersplat-bridge/src/worldgraph-wasm/` (git-ignored — it is a build artifact).

### 2. Use it from SuperSplat (TypeScript)

```ts
import {
  SemanticVisualizer, WorldgraphScene, PlayCanvasBackend,
  PersonTrackLayer, ProvenancePanel
} from '@worldgraph/supersplat-bridge';
import * as pc from 'playcanvas';

// 1. Load the twin from its RVF/JSON payload (WorldGraph::to_json output).
const viz = new SemanticVisualizer();
await viz.initialize({ rvfJson });

// 2. Draw it over the splat and keep it in sync.
const scene = new WorldgraphScene(new PlayCanvasBackend(pc, app));
scene.sync(viz.renderPrimitives());            // green room boxes, sensor spheres, …

// 3. Zero-video control room: feed anonymous RF tracks each tick.
const people = new PersonTrackLayer(viz);
people.apply([{ trackId: 7, position: { east_m: 3, north_m: 2, up_m: 0 } }]);
scene.sync(viz.renderPrimitives());            // avatar moves; no cameras

// 4. Click-to-audit: resolve a scene pick to its provenance card.
const panel = new ProvenancePanel(viz);
const card = panel.onPickEntity(pickedEntity.name); // "person_track:42"
```

## Test (no browser, no wasm target required)

```bash
cargo test -p worldgraph-wasm          # 14 native tests pin the Rust contract
cd supersplat-bridge && npm install && npm test   # 18 TS tests (vitest), tsc --noEmit
```

The TypeScript layer injects the WASM module, so the bridge is fully testable
against an in-memory fake (`__tests__/fake-bridge.ts`) — the real `.wasm` is a
deployment artifact, not a test dependency.

## The four applications

| # | Module | What it enables |
|---|--------|-----------------|
| 1 | `usecases/avatars.ts` | Zero-video control room — anonymous avatars moving live over the splat |
| 2 | `usecases/configurator.ts` | Drag boxes/markers in 3-D → export a compliant RVF/JSON twin |
| 3 | `usecases/occworld.ts` | Overlay OccWorld trajectory predictions as fading 3-D paths |
| 4 | `usecases/audit.ts` | Click any node → fly out its provenance / audit trail |

See [ADR-202](docs/adr/ADR-202-spatial-applications.md) for the design of each.
