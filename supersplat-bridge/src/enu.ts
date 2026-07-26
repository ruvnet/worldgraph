// ADR-201 — the ENU ⇄ PlayCanvas coordinate contract, TypeScript side.
//
// This mirrors `worldgraph-wasm/src/enu.rs` exactly. The canonical mapping lives
// in Rust (every primitive the bridge emits is already mapped); these helpers
// exist for client-side previews and for projecting gizmo edits back to ENU
// before they reach the configurator.

import type { EnuPoint, Vec3 } from './types.js';

/** Normalize `-0` → `0` so emitted coordinates never carry a surprising `-0`. */
function nz(x: number): number {
  return x === 0 ? 0 : x;
}

/**
 * ENU (East, North, Up) → PlayCanvas (X, Y, Z), Y-up right-handed:
 *   X = East, Y = Up, Z = -North.
 */
export function enuToPlayCanvas(p: EnuPoint): Vec3 {
  return [nz(p.east_m), nz(p.up_m), nz(-p.north_m)];
}

/** Inverse mapping: PlayCanvas `[x, y, z]` → ENU point. */
export function playCanvasToEnu([x, y, z]: Vec3): EnuPoint {
  return { east_m: nz(x), north_m: nz(-z), up_m: nz(y) };
}

/**
 * Project a PlayCanvas box gizmo (centre + size) to an ENU rectangle, matching
 * `core::room_from_box`. Used for live previews before the WASM round-trip.
 */
export function pcBoxToEnuRectangle(
  center: Vec3,
  size: Vec3
): { min_e: number; min_n: number; max_e: number; max_n: number } {
  const c = playCanvasToEnu(center);
  const halfE = Math.abs(size[0]) / 2;
  const halfN = Math.abs(size[2]) / 2; // PlayCanvas z extent → ENU north extent
  return {
    min_e: c.east_m - halfE,
    min_n: c.north_m - halfN,
    max_e: c.east_m + halfE,
    max_n: c.north_m + halfN
  };
}
