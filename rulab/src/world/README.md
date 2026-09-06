# Temporal WorldGraph contract

`TimelineStore` is a deterministic authored scenario simulator. It performs no neural inference, sensor ingestion, or equipment control. An authored confidence of 1 means the scenario definition is known exactly; it does not express measurement accuracy or confidence in future real motion.

## Replay and branches

```ts
const timeline = new TimelineStore('robotics');
timeline.record({ kind: 'door', entityId: 'rf-door', value: true }, 10);
timeline.record({ kind: 'pause-agent', entityId: 'amr-1', value: true }, 20);
timeline.record({ kind: 'pause-agent', entityId: 'amr-1', value: false }, 30);
const frame = timeline.seek(45);
const restored = TimelineStore.fromJson(timeline.exportJson());
// restored.seek(45) equals frame, regardless of previous frame cadence.
```

1. Duration is 120 seconds. Finite seeks clamp to the interval; invalid event timestamps are rejected.
2. Events have monotonically increasing edit sequences. Playback applies timestamp order, with sequence breaking ties. Editing after a rewind is supported.
3. Each of robotics, hospitality, and healthcare has an isolated event branch. Switching scenarios resets the playhead to zero while retaining edits.
4. Pausing an agent freezes its analytical motion clock. Resuming does not teleport it to the original wall clock trajectory.
5. Door joints are radians from zero to pi/2. A 1.2 second smooth transition preserves continuity when reversed.
6. Returned frames and events are copies. Import is atomic and bounded to 1 MiB and 1024 events per branch. Unknown fields, invalid action/entity combinations, mismatched IDs, conflicting duplicates, unsafe integers, and nonmonotonic edit sequences are rejected. Identical event retransmissions are idempotent.
7. The final safe integer sequence can be recorded, exported, and restored. A subsequent record raises `RangeError` before changing state.

## Spatial convention and envelope checks

Positions are `[East, North, Up]` in metres. Yaw zero points East and positive pi/2 points North. A Three.js view maps positions to `[East, Up, -North]`.

The authored hall footprint is East from -12 to 12 m and North from -17 to 17 m, with an 11 m ceiling. The RF room footprint is East from 7.7 to 12 m and North from -0.2 to 6.2 m. These bounds match the rendered shell.

| Object | Authored constraint |
| --- | --- |
| Robot | Base `[0,2,0]`; horizontal exclusion radius 1.65 m; maximum envelope height 3.3 m |
| AMR | Rounded rectangular route with East extrema ±2.6 m, North extrema from -6.5 to 5.6 m, 0.8 m corner radius; body radius at most 0.55 m |
| Drone | East radius 3 m, North radius 2 m; altitude 4.6 to 5 m; body radius at most 0.45 m |
| RF door | Hinge anchor `[9,3,0]` |
| UWB anchor | `[-8,4,3]` |
| WiFi CSI sensor | `[8,-4,3]` |

The AMR route has at least 0.40 m separation from the robot exclusion envelope after accounting for its body radius. The drone body is at least 0.85 m above the robot height envelope. These checks apply to the authored primitives only. They do not certify robot joint geometry, moving people, rendered props, radio propagation, or real equipment safety. The timeline has no generic collision solver.

## Actual Rust integration

`RuLabGraph.initialize()` loads `public/wasm/worldgraph_wasm.js`, built from the repository's Rust crate. Failure remains visible through `status` and `error`; there is no JavaScript graph replacement.

`sync(frame)` validates the whole input before applying supported `upsert_node` and `upsert_edge` messages. It creates 14 nodes and 14 relationships with stable IDs. Exact duplicate messages are suppressed. Schedule graph updates at the semantic update cadence, independently of animation rendering.

The current Rust schema has no articulated robot node. Robot, AMR, and drone positions are projected into `ObjectAnchor` nodes classified as reflectors. An associated `SemanticState` preserves actual object kind, joints, orientation, replay timestamp, scenario, and authored provenance. Sensors use `Sensor` nodes and the RF door uses `Doorway`. This compatibility mapping must not be mistaken for a new native Rust dynamics schema.

`exportJson()` returns the actual Rust RVF JSON snapshot. Its synthetic replay epoch is January 1, 2026 UTC, explicitly paired with `rulab-concept-enu-v1-not-surveyed` calibration and `synthetic:no-personal-data` provenance. It is not an observation timestamp. Motion event history is retained separately by `TimelineStore.exportJson()`.

## Validation

From `rulab`:

```sh
npm run build:wasm
npx vitest run src/world
```

The WASM integration test fails if the compiled binary is absent. It executes the actual Rust module, checks stable node and edge counts across 121 replay updates, verifies exact snapshot restoration after a reverse seek, and validates scenario switching. Adapter unit tests use explicitly labelled marshaling doubles; those tests alone do not establish Rust execution.
