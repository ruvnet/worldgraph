//! Repeatable release-mode adapter benchmark. No PAN2 inference or GPU claim.
use std::{hint::black_box, time::Instant};
use wifi_densepose_worldgraph::{EnuPoint, WorldGraph, WorldId, WorldNode};
use wifi_densepose_worldmodel::{physical::*, PrivacyDecision, RetentionPolicy};

fn main() {
    let mut results = Vec::new();
    for (tracks, points, obstacles) in [(1, 8, 0), (16, 32, 32), (64, 32, 128)] {
        let mut graph = WorldGraph::new(Default::default());
        let mut ids = Vec::new();
        for i in 0..tracks {
            ids.push(graph.upsert_node(WorldNode::PersonTrack {
                id: WorldId::UNASSIGNED,
                track_id: i as u64,
                last_position: EnuPoint {
                    east_m: 0.0,
                    north_m: i as f64 * 0.03,
                    up_m: 1.0,
                },
                reid_embedding_ref: None,
            }));
        }
        let context = PhysicalContext {
            source_epoch: 1,
            observed_at_ms: 1000,
            frame_id: "benchmark-enu".into(),
            calibration_id: "fixture/1".into(),
            action: "synthetic movement".into(),
            horizon_ms: 5000,
            generation_seed: 123,
            bounds: PhysicalBounds {
                min: [-10.0, -10.0, 0.0],
                max: [10.0, 10.0, 3.0],
            },
            obstacles: (0..obstacles)
                .map(|i| PhysicalBounds {
                    min: [5.0, i as f64 * 0.02, 0.0],
                    max: [6.0, i as f64 * 0.02 + 0.01, 2.0],
                })
                .collect(),
            max_speed_mps: 3.0,
            privacy: PrivacyDecision {
                projection_id: "benchmark-fixture".into(),
                hosted_processing_approved: false,
                redactions_applied: 0,
                retention: RetentionPolicy::Ephemeral,
            },
        };
        let scene = PreparedPhysicalScene::from_graph(&graph, &ids, context.clone()).unwrap();
        let response = Pan2PhysicalResponse {
            schema_version: 1,
            request_sha256: scene.request_sha256().unwrap(),
            model_sha256: "a".repeat(64),
            artifact_sha256: "b".repeat(64),
            extractor_version: "benchmark-fixture/1".into(),
            frame_id: context.frame_id.clone(),
            calibration_id: context.calibration_id.clone(),
            execution: PhysicalExecution::Fixture,
            trajectories: (0..tracks)
                .map(|i| PhysicalTrajectory {
                    track_id: i as u64,
                    points: (1..=points)
                        .map(|n| PhysicalPoint {
                            offset_ms: n * 100,
                            position_m: [n as f64 * 0.01, i as f64 * 0.03, 1.0],
                        })
                        .collect(),
                })
                .collect(),
        };
        let bytes = serde_json::to_vec(&response).unwrap();
        assert!(bytes.len() < MAX_PHYSICAL_BYTES);
        let observations = PhysicalObservations {
            request_sha256: response.request_sha256.clone(),
            frame_id: context.frame_id.clone(),
            calibration_id: context.calibration_id.clone(),
            observed_at_ms: context.observed_at_ms,
            samples: response
                .trajectories
                .iter()
                .flat_map(|t| {
                    t.points.iter().map(|p| PhysicalObservation {
                        track_id: t.track_id,
                        offset_ms: p.offset_ms,
                        position_m: p.position_m,
                    })
                })
                .collect(),
        };
        let branch = scene.accept_json(&bytes).unwrap();
        let mut stages = serde_json::Map::new();
        for stage in ["prepare", "request_hash", "validate", "reconcile", "branch"] {
            let iterations = if stage == "request_hash" { 1000 } else { 50 };
            let mut timings = Vec::new();
            for round in 0..8 {
                let start = Instant::now();
                for _ in 0..iterations {
                    match stage {
                        "prepare" => {
                            black_box(
                                PreparedPhysicalScene::from_graph(&graph, &ids, context.clone())
                                    .unwrap(),
                            );
                        }
                        "request_hash" => {
                            black_box(scene.request_sha256().unwrap());
                        }
                        "validate" => {
                            black_box(scene.accept_json(&bytes).unwrap());
                        }
                        "reconcile" => {
                            black_box(branch.reconcile(&observations).unwrap());
                        }
                        _ => {
                            black_box(branch.hypothesis_graph(&graph).unwrap());
                        }
                    }
                }
                if round > 0 {
                    timings.push(start.elapsed().as_nanos() as f64 / iterations as f64 / 1000.0);
                }
            }
            timings.sort_by(f64::total_cmp);
            stages.insert(stage.into(),serde_json::json!({"median_us":timings[3],"min_us":timings[0],"max_us":timings[6],"rounds":7,"iterations_per_round":iterations}));
        }
        results.push(serde_json::json!({"tracks":tracks,"points_per_track":points,"obstacles":obstacles,"response_bytes":bytes.len(),"stages":stages}));
    }
    println!("{}",serde_json::to_string_pretty(&serde_json::json!({"scope":"synthetic adapter CPU benchmark; no PAN2 inference","cases":results})).unwrap());
}
