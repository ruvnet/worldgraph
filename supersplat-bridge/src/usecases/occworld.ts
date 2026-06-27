// ADR-202 §3 — Visual Debugger for the OccWorld predictive model.
//
// `wifi-densepose-worldmodel` forecasts where a tracked person is statistically
// likely to move next. This module overlays that prediction as a fading polyline
// fanning out from the live avatar, so an engineer can *see* a bad prediction —
// e.g. a path that drives straight through a couch plainly visible in the splat.
//
// The canonical overlay is built in Rust (`overlay::trajectory_overlay`, reached
// via `viz.trajectoryOverlay`). The pure `buildTrajectoryOverlay` here mirrors it
// for client-side preview and tests; both must agree (a test pins the contract).

import type { EnuPoint, RenderPrimitive, TrajectoryStep } from '../types.js';
import type { SemanticVisualizer } from '../wasm-bridge.js';
import { enuToPlayCanvas } from '../enu.js';

/**
 * Pure mirror of `overlay::trajectory_overlay`: chain `Line` primitives from the
 * avatar through each predicted waypoint, colour ramping hot→cool with step
 * index and alpha scaling with the step probability.
 */
export function buildTrajectoryOverlay(
  trackId: number,
  from: EnuPoint,
  steps: readonly TrajectoryStep[]
): RenderPrimitive[] {
  const out: RenderPrimitive[] = [];
  let prev = enuToPlayCanvas(from);
  const n = Math.max(steps.length, 1);
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const next = enuToPlayCanvas(step.point);
    const t = i / n;
    const alpha = Math.min(Math.max(step.probability, 0), 1);
    out.push({
      id: trackId,
      kind: 'trajectory',
      shape: 'line',
      label: `p=${step.probability.toFixed(2)}`,
      position: prev,
      scale: [1, 1, 1],
      color: [t, 1 - t, 0.2, alpha],
      to: next,
      transparent: true
    });
    prev = next;
  }
  return out;
}

/**
 * Overlays OccWorld predictions on the scene.
 *
 * Feed each fresh prediction; it asks the WASM twin for the overlay primitives
 * (so Rust stays the single source of geometry truth) and hands them straight to
 * `scene.sync` alongside the regular twin primitives.
 */
export class TrajectoryOverlay {
  constructor(private readonly viz: SemanticVisualizer) {}

  /** Build overlay primitives for a person's predicted path (via WASM). */
  forPrediction(trackId: number, from: EnuPoint, steps: TrajectoryStep[]): RenderPrimitive[] {
    return this.viz.trajectoryOverlay(trackId, from, steps);
  }
}
