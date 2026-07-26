//! ADR-201 — the single source of truth for the ENU ⇄ PlayCanvas coordinate
//! contract.
//!
//! WorldGraph stores positions in the installation's **ENU** frame: a
//! right-handed metric frame with `+East`, `+North`, `+Up` (ADR-044). PlayCanvas
//! (and therefore SuperSplat / the Gaussian splat it renders) uses a
//! right-handed, **Y-up** frame: `+X` right, `+Y` up, `-Z` forward.
//!
//! The only mapping that keeps a right-handed frame right-handed while sending
//! `Up → Y` is:
//!
//! ```text
//!   X =  East
//!   Y =  Up
//!   Z = -North
//! ```
//!
//! Every primitive the bridge hands to the browser is pre-transformed through
//! [`enu_to_pc`] so the TypeScript side never re-derives the convention (and so a
//! sign error is caught here, once, by a unit test instead of by eyeballing a
//! mis-placed avatar in three.js space).

use wifi_densepose_worldgraph::EnuPoint;

/// Normalize negative zero to positive zero so emitted coordinates never carry a
/// surprising `-0.0` (e.g. for a person walking exactly along the east axis).
#[inline]
fn nz(x: f64) -> f64 {
    if x == 0.0 {
        0.0
    } else {
        x
    }
}

/// Map an ENU point (metres) to a PlayCanvas `[x, y, z]` position (metres).
#[must_use]
pub fn enu_to_pc(p: &EnuPoint) -> [f64; 3] {
    [nz(p.east_m), nz(p.up_m), nz(-p.north_m)]
}

/// Map raw ENU components to a PlayCanvas `[x, y, z]` position.
#[must_use]
pub fn enu_xyz_to_pc(east_m: f64, north_m: f64, up_m: f64) -> [f64; 3] {
    [nz(east_m), nz(up_m), nz(-north_m)]
}

/// Inverse of [`enu_to_pc`]: a PlayCanvas `[x, y, z]` back to an [`EnuPoint`].
///
/// Used by the visual configurator (ADR-202 §2): an installer drags a gizmo in
/// PlayCanvas space and we must serialize the result back into the ENU frame the
/// RVF payload speaks.
#[must_use]
pub fn pc_to_enu(xyz: [f64; 3]) -> EnuPoint {
    EnuPoint { east_m: nz(xyz[0]), north_m: nz(-xyz[2]), up_m: nz(xyz[1]) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enu(e: f64, n: f64, u: f64) -> EnuPoint {
        EnuPoint { east_m: e, north_m: n, up_m: u }
    }

    #[test]
    fn forward_mapping_sends_up_to_y_and_negates_north() {
        assert_eq!(enu_to_pc(&enu(1.0, 2.0, 3.0)), [1.0, 3.0, -2.0]);
    }

    #[test]
    fn round_trips_through_inverse() {
        let p = enu(4.5, -7.25, 2.0);
        let back = pc_to_enu(enu_to_pc(&p));
        assert_eq!(back.east_m, p.east_m);
        assert_eq!(back.north_m, p.north_m);
        assert_eq!(back.up_m, p.up_m);
    }

    #[test]
    fn mapping_preserves_handedness() {
        // ENU is right-handed: East × North = Up. An orientation-preserving
        // mapping keeps that relation, so image(E) × image(N) must equal
        // image(U) (no accidental mirror of the splat).
        let e = enu_xyz_to_pc(1.0, 0.0, 0.0); // East  -> ( 1, 0,  0)
        let n = enu_xyz_to_pc(0.0, 1.0, 0.0); // North -> ( 0, 0, -1)
        let u = enu_xyz_to_pc(0.0, 0.0, 1.0); // Up    -> ( 0, 1,  0)
        let cross = [
            e[1] * n[2] - e[2] * n[1],
            e[2] * n[0] - e[0] * n[2],
            e[0] * n[1] - e[1] * n[0],
        ];
        assert_eq!(cross, u);
    }
}
