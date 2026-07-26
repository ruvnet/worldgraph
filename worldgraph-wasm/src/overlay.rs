//! ADR-202 §3 — OccWorld predictive-overlay primitives.
//!
//! The `wifi-densepose-worldmodel` crate forecasts a person's near-future
//! trajectory prior. Debugging that probabilistic model in a terminal is hard;
//! here we turn a predicted ENU path into PlayCanvas `Line` primitives that fan
//! out from the live avatar, fading from hot (imminent) to cool (later), so a
//! hardware engineer can *see* where the model expects motion to go — and notice
//! when it ignores a couch that is plainly visible in the splat.

use serde::{Deserialize, Serialize};
use wifi_densepose_worldgraph::EnuPoint;

use crate::core::{PrimitiveShape, RenderPrimitive};
use crate::enu::enu_to_pc;

/// One predicted step: an ENU waypoint plus the model's probability mass.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TrajectoryStep {
    /// Predicted ENU position.
    pub point: EnuPoint,
    /// Probability / confidence in `0.0..=1.0`.
    pub probability: f32,
}

/// Build the polyline of `Line` primitives for a predicted trajectory.
///
/// `track_id` tags the primitives so a later prediction for the same person can
/// replace the old overlay. The first segment starts at the avatar's current
/// position (`from`); each subsequent segment chains to the next waypoint. Colour
/// ramps green→red with step index (imminent = hot), alpha scales with the step
/// probability so low-confidence tails visibly fade out.
#[must_use]
pub fn trajectory_overlay(track_id: u64, from: &EnuPoint, steps: &[TrajectoryStep]) -> Vec<RenderPrimitive> {
    let mut out = Vec::with_capacity(steps.len());
    let mut prev = enu_to_pc(from);
    let n = steps.len().max(1) as f32;
    for (i, step) in steps.iter().enumerate() {
        let next = enu_to_pc(&step.point);
        let t = i as f32 / n; // 0 (imminent) → ~1 (far)
        let alpha = step.probability.clamp(0.0, 1.0);
        out.push(RenderPrimitive {
            id: track_id,
            kind: "trajectory".into(),
            shape: PrimitiveShape::Line,
            label: format!("p={:.2}", step.probability),
            position: prev,
            scale: [1.0; 3],
            color: [t, 1.0 - t, 0.2, alpha],
            to: Some(next),
            transparent: true,
        });
        prev = next;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enu(e: f64, n: f64) -> EnuPoint {
        EnuPoint { east_m: e, north_m: n, up_m: 0.0 }
    }

    #[test]
    fn overlay_chains_segments_from_avatar() {
        let steps = vec![
            TrajectoryStep { point: enu(1.0, 0.0), probability: 0.9 },
            TrajectoryStep { point: enu(2.0, 0.0), probability: 0.5 },
        ];
        let prims = trajectory_overlay(7, &enu(0.0, 0.0), &steps);
        assert_eq!(prims.len(), 2);
        // First segment starts at the avatar origin in PlayCanvas space.
        assert_eq!(prims[0].position, [0.0, 0.0, 0.0]);
        assert_eq!(prims[0].to, Some([1.0, 0.0, 0.0]));
        // Second segment starts where the first ended (chained).
        assert_eq!(prims[1].position, [1.0, 0.0, 0.0]);
        assert_eq!(prims[1].to, Some([2.0, 0.0, 0.0]));
        // Later step is lower-confidence → lower alpha.
        assert!(prims[1].color[3] < prims[0].color[3]);
        assert!(prims.iter().all(|p| p.id == 7 && p.shape == PrimitiveShape::Line));
    }

    #[test]
    fn empty_prediction_yields_no_primitives() {
        assert!(trajectory_overlay(1, &enu(0.0, 0.0), &[]).is_empty());
    }
}
