import { describe, it, expect } from 'vitest';
import { enuToPlayCanvas, playCanvasToEnu, pcBoxToEnuRectangle } from '../src/enu.js';

describe('ENU ⇄ PlayCanvas mapping (ADR-201)', () => {
  it('sends Up→Y and negates North', () => {
    expect(enuToPlayCanvas({ east_m: 1, north_m: 2, up_m: 3 })).toEqual([1, 3, -2]);
  });

  it('round-trips through the inverse', () => {
    const p = { east_m: 4.5, north_m: -7.25, up_m: 2 };
    expect(playCanvasToEnu(enuToPlayCanvas(p))).toEqual(p);
  });

  it('projects a box gizmo to an ENU rectangle matching the Rust core', () => {
    // Mirrors core::room_from_box's documented example.
    const r = pcBoxToEnuRectangle([3.5, 1.25, -2.0], [4, 2.5, 3]);
    expect(r).toEqual({ min_e: 1.5, min_n: 0.5, max_e: 5.5, max_n: 3.5 });
  });
});
