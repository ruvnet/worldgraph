# ADR-202 — The four spatial applications over the bridge

- **Status:** Accepted
- **Date:** 2026-06-27
- **Relates to:** ADR-200 (bridge), ADR-201 (coordinates), ADR-139 (model), ADR-141 (privacy), ADR-147 (OccWorld)

## Context

The bridge (ADR-200) makes the twin queryable in the browser. This ADR records
the four applications it is built to enable, and the API each one needs. The
unifying property: **see *what* is happening in a space without looking at *who*
is in it** — RF/ambient sensing, never video.

## Decision

Ship four use-case modules in `@worldgraph/supersplat-bridge`, each a thin,
unit-tested orchestration over `SemanticVisualizer` + `WorldgraphScene`.

### §1 Zero-video interactive control room — `usecases/avatars.ts`

An external RF/ambient layer (WiFi CSI / mmWave / UWB) reports **anonymous**
track positions. `PersonTrackLayer.apply()` upserts each into the twin keyed by a
`trackId → WorldId` registry, so a repeated report for the same person *moves*
the existing avatar instead of spawning a duplicate. `WorldgraphScene.sync()`
then reconciles primitives into the scene — create / update-in-place / destroy —
so avatars glide and a person who leaves is removed. No cameras ⇒ no video to
leak.

> Render path: `viz.upsertPerson()` → `viz.renderPrimitives()` → `scene.sync()`.
> Person nodes become anonymous capsules (`person #<track_id>`, no identity).

### §2 Physical-to-digital configurator — `usecases/configurator.ts`

Turns SuperSplat's transform gizmos into a WorldGraph authoring tool. The
installer drags boxes over rooms and drops markers where they mounted routers;
`Configurator.addRoom()/addSensor()` forward the PlayCanvas transforms to
`addRoomFromBox`/`addSensorFromMarker`, which project them back to ENU
(ADR-201 inverse) inside Rust. `exportRvf()` serializes a **compliant RVF/JSON
payload** via `WorldGraph::to_json`. `previewRoomBounds()` echoes ENU extents
live, client-side, before the WASM round-trip. Non-technical staff configure a
spatial graph without typing a coordinate grid.

### §3 OccWorld predictive debugger — `usecases/occworld.ts`

`wifi-densepose-worldmodel` (ADR-147) forecasts a person's near-future
trajectory prior. `viz.trajectoryOverlay()` (Rust `overlay::trajectory_overlay`)
turns a predicted ENU path into a chained polyline that fans out from the live
avatar: colour ramps hot→cool with step index, alpha scales with each step's
probability so low-confidence tails fade. An engineer *sees* a bad prediction —
e.g. a path driving straight through a couch visible in the splat. A pure TS
mirror (`buildTrajectoryOverlay`) backs previews/tests and is pinned to agree
with the Rust path.

### §4 Click-to-audit provenance — `usecases/audit.ts`

WorldGraph enforces semantic provenance (every belief traces to evidence + model
+ calibration + privacy decision). On a scene pick, `ProvenancePanel` resolves
the entity key (`"person_track:42"`) to a `WorldId`, pulls the
`ProvenanceCard` from Rust WASM memory (`getProvenance`), and formats it for an
info panel. The card is assembled in `core::provenance_for` from the node's own
fields plus its `derived_from` / `contradicts` edges:

| Clicked element     | WorldNode            | Card summary (example)                                            |
|---------------------|----------------------|-------------------------------------------------------------------|
| Person avatar       | `PersonTrack`        | "Anonymous RF/ambient track — identity obfuscated; no video."     |
| Smart-appliance box | `ObjectAnchor`       | "Static furniture anchor; confidence 94%."                        |
| Highlighted room    | `Room`               | "Geospatially grounded room linked to HomeCore area `kitchen`."   |
| Belief (abstract)   | `SemanticState`      | "'occupied' — fused via model rfenc-2.1 (cal …) under privacy …." |

## Consequences

- Each application is a small module with a clear seam to the (mock-able) WASM
  bridge, so all four are unit-tested headlessly (`usecases.test.ts`).
- Privacy is structural, not bolted on: person nodes carry no identity, and the
  audit card surfaces the privacy decision rather than raw signals.
- The geometry source of truth stays in Rust; TS mirrors exist only for preview
  and are contract-tested against it.
