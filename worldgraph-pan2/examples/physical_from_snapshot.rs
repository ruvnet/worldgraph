//! Build a physical request from an API snapshot response and write a contract-fixture forecast
//! as a Spaces simulation body.
//!
//!   cargo run -p worldgraph-pan2 --example physical_from_snapshot -- \
//!     <snapshot.json> <site-id> <space-id> <out-simulation.json>
//!
//! The forecast is a straight walk at half the zone speed limit. It is a *fixture* (it says so in the
//! record) that exercises the protocol; no PAN 2 extractor is involved.
use wifi_densepose_worldmodel::physical::*;
use worldgraph_pan2::physical_spaces::*;
use worldgraph_pan2::spaces::{EventIdentity, SpacesTarget};
use worldgraph_pan2::spaces_scene::SpacesSnapshot;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [snapshot_path, site, space, out] = args.as_slice() else {
        return Err(
            "usage: physical_from_snapshot <snapshot.json> <site-id> <space-id> <out.json>".into(),
        );
    };
    let snapshot = SpacesSnapshot::from_json(&std::fs::read(snapshot_path)?)?;
    let options = HypothesisOptions {
        source_epoch: 1,
        observed_at_ms: 1_000,
        action: "each person keeps walking along +x".into(),
        horizon_ms: 2_000,
        generation_seed: 7,
        default_max_speed_mps: 1.0,
        hosted_processing_approved: false,
    };
    let built = physical_scene_from_snapshot(&snapshot, &options)?;
    let prepared = built.prepare()?;
    let step = 0.5 * built.context.max_speed_mps * 2.0; // half the limit over the 2 s horizon
    let response = Pan2PhysicalResponse {
        schema_version: 1,
        request_sha256: prepared.request_sha256()?,
        model_sha256: "0".repeat(64),
        artifact_sha256: "1".repeat(64),
        extractor_version: "straight-walk-contract-fixture/1".into(),
        frame_id: built.context.frame_id.clone(),
        calibration_id: built.context.calibration_id.clone(),
        execution: PhysicalExecution::Fixture,
        trajectories: prepared
            .request()
            .tracks
            .iter()
            .map(|t| PhysicalTrajectory {
                track_id: t.track_id,
                points: vec![PhysicalPoint {
                    offset_ms: 2_000,
                    position_m: [t.position_m[0] + step, t.position_m[1], t.position_m[2]],
                }],
            })
            .collect(),
    };
    let branch = prepared.accept_json(&serde_json::to_vec(&response)?)?;
    let body = hypothesis_simulation(
        &branch,
        &built,
        &SpacesTarget {
            site_id: site.clone(),
            space_id: space.clone(),
        },
        &EventIdentity {
            id: format!("hyp-{space}"),
            message_id: format!("msg-hyp-{space}"),
            event_sequence: 1,
            observed_at: "2026-11-11T12:00:00Z".into(),
        },
    )?;
    std::fs::write(out, serde_json::to_vec_pretty(&body)?)?;
    println!(
        "wrote {out}: {} tracks, snapshot {}",
        built.ids.len(),
        built.source_hash
    );
    Ok(())
}
