# ADR-201 — ENU ⇄ PlayCanvas coordinate contract

- **Status:** Accepted
- **Date:** 2026-06-27
- **Relates to:** ADR-044 (installation ENU frame), ADR-200 (bridge)

## Context

WorldGraph positions live in the installation **ENU** frame: right-handed,
metric, `+East`, `+North`, `+Up` (ADR-044). PlayCanvas — and therefore the
Gaussian splat SuperSplat renders — uses a right-handed **Y-up** frame: `+X`
right, `+Y` up, `-Z` forward.

If the avatar floats sideways or the room boxes mirror the splat, it is almost
always a coordinate-frame bug. We want exactly one place where the convention is
defined, and a test that fails if anyone changes a sign.

## Decision

The single mapping, defined in `worldgraph-wasm/src/enu.rs` and mirrored in
`supersplat-bridge/src/enu.ts`:

```
X =  East
Y =  Up
Z = -North
```

- This is the unique mapping that sends `Up → Y` **and** preserves handedness
  (so the splat is not mirrored). The handedness invariant `image(E) × image(N)
  = image(U)` is asserted by a unit test.
- The inverse (`pc_to_enu` / `playCanvasToEnu`) is used by the visual
  configurator (ADR-202 §2) to project gizmo edits back into ENU for the RVF.
- Box footprints map their ENU extents to PlayCanvas scale axes as
  `east → x`, `north → z`, with the up axis carrying the (extruded) room height.
- **Negative zero is normalized to `+0`.** A person walking exactly along the
  east axis has `north_m = 0`, and `-0.0` would otherwise leak into every emitted
  `z`. Harmless numerically, but it surprises structural equality and serialized
  diffs, so both sides clamp `-0 → 0`.

Every primitive the bridge emits is **already mapped** — the TypeScript side
never re-derives the convention. The TS `enu.ts` helpers exist only for
client-side previews (e.g. echoing ENU bounds as the installer drags a gizmo)
and are pinned to the Rust behaviour by a shared-value test
(`pcBoxToEnuRectangle` reproduces `core::room_from_box`'s documented example).

## Consequences

- One mapping, two implementations, one set of values asserted on both sides.
- A sign error is a failing test in CI, not a visual artifact a human has to
  notice in 3-space.
- Rooms are extruded to a default 2.5 m ceiling (`DEFAULT_ROOM_HEIGHT_M`) because
  WorldGraph footprints are 2-D; the configurator can override per-room.
