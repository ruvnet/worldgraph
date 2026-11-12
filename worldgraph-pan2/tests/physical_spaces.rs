//! Spaces snapshot -> physical hypothesis -> labelled simulation, end to end without a GPU.
use serde_json::{json, Value};
use wifi_densepose_worldmodel::physical::*;
use worldgraph_pan2::canonical::snapshot_hash;
use worldgraph_pan2::physical_spaces::*;
use worldgraph_pan2::spaces::{validate_simulation, EventIdentity, SpacesTarget};
use worldgraph_pan2::spaces_scene::SpacesSnapshot;

fn data(person_identity: &str, person_x: f64) -> Value {
    json!({
        "site": {"id": "hq", "name": "HQ"},
        "space": {"id": "hall", "name": "Hall", "attributes": {},
                  "placement": {"frame": "floor-local-m", "centerM": [0.0, 0.0, 1.5], "sizeM": [20.0, 10.0, 3.0]}},
        "zones": [{"id": "lane", "name": "Lane", "attributes": {}, "physics": {"maxSpeedMps": 1.5}},
                  {"id": "dock", "name": "Dock", "attributes": {}, "physics": {"maxSpeedMps": 0.8}}],
        "entities": [
            {"id": "p1", "name": "Walker", "entityType": "person", "identityMode": person_identity, "attributes": {},
             "placement": {"frame": "space-local-m", "centerM": [person_x, 0.0, 1.0]}},
            {"id": "rack", "name": "Rack", "entityType": "object", "attributes": {},
             "placement": {"frame": "space-local-m", "centerM": [5.0, 0.0, 1.0], "sizeM": [1.0, 4.0, 2.0]}}
        ],
        "events": null
    })
}

fn api_response(data: Value) -> Vec<u8> {
    let hash = snapshot_hash(&data);
    serde_json::to_vec(
        &json!({"object": "snapshot", "schemaVersion": "1.0", "snapshotHash": hash,
        "asOf": "2026-11-11T12:00:00.000Z", "eventsStatus": "omitted", "data": data}),
    )
    .unwrap()
}

fn options() -> HypothesisOptions {
    HypothesisOptions {
        source_epoch: 1,
        observed_at_ms: 1000,
        action: "walker crosses toward the rack".into(),
        horizon_ms: 2000,
        generation_seed: 99,
        default_max_speed_mps: 3.0,
        hosted_processing_approved: false,
    }
}

fn fixture_response(scene: &PreparedPhysicalScene, to: [f64; 3]) -> Pan2PhysicalResponse {
    let ctx = &scene.request().context;
    Pan2PhysicalResponse {
        schema_version: 1,
        request_sha256: scene.request_sha256().unwrap(),
        model_sha256: "a".repeat(64),
        artifact_sha256: "b".repeat(64),
        extractor_version: "synthetic-contract-fixture/1".into(),
        frame_id: ctx.frame_id.clone(),
        calibration_id: ctx.calibration_id.clone(),
        execution: PhysicalExecution::Fixture,
        trajectories: scene
            .request()
            .tracks
            .iter()
            .map(|t| PhysicalTrajectory {
                track_id: t.track_id,
                points: vec![PhysicalPoint {
                    offset_ms: 2000,
                    position_m: to,
                }],
            })
            .collect(),
    }
}

#[test]
fn verified_snapshot_becomes_a_validated_forecast_and_a_labelled_simulation() {
    let snapshot = SpacesSnapshot::from_json(&api_response(data("anonymous", -6.0))).unwrap();
    let built = physical_scene_from_snapshot(&snapshot, &options()).unwrap();
    // The most conservative zone limit wins, obstacles come from placed objects.
    assert_eq!(built.context.max_speed_mps, 0.8);
    assert_eq!(built.context.obstacles.len(), 1);
    assert_eq!(built.context.bounds.max, [10.0, 5.0, 3.0]);
    let prepared = built.prepare().unwrap();
    let json = serde_json::to_string(prepared.request()).unwrap();
    assert!(!json.contains("Walker"), "names never reach the worker");
    // -6.0 -> -5.0 in 2 s is 0.5 m/s: allowed and clear of the rack at x 4.5..5.5.
    let branch = prepared
        .accept_json(&serde_json::to_vec(&fixture_response(&prepared, [-5.0, 0.0, 1.0])).unwrap())
        .unwrap();
    assert_eq!(
        branch.hypothesis_graph(&built.graph).unwrap().node_count(),
        built.graph.node_count() + 1
    );

    let body = hypothesis_simulation(
        &branch,
        &built,
        &SpacesTarget {
            site_id: "hq".into(),
            space_id: "hall".into(),
        },
        &EventIdentity {
            id: "hyp-1".into(),
            message_id: "msg-hyp-1".into(),
            event_sequence: 1,
            observed_at: "2026-11-11T12:00:01Z".into(),
        },
    )
    .unwrap();
    validate_simulation(&body).unwrap();
    assert_eq!(body["confidence"], 0);
    assert_eq!(body["simulationType"], HYPOTHESIS_SIMULATION_TYPE);
    assert_eq!(
        body["provenance"]["sourceSnapshotHash"],
        Value::String(built.source_hash.clone())
    );
    assert!(body["attributes"]["label"]
        .as_str()
        .unwrap()
        .contains("fixture"));
    fn no_nested_array(v: &Value) -> bool {
        match v {
            Value::Array(items) => items.iter().all(|i| !i.is_array() && no_nested_array(i)),
            Value::Object(map) => map.values().all(no_nested_array),
            _ => true,
        }
    }
    assert!(
        no_nested_array(&body),
        "Firestore rejects an array inside an array"
    );
}

#[test]
fn a_forecast_faster_than_the_zone_limit_is_rejected_by_the_validator() {
    let snapshot = SpacesSnapshot::from_json(&api_response(data("anonymous", -6.0))).unwrap();
    let built = physical_scene_from_snapshot(&snapshot, &options()).unwrap();
    let prepared = built.prepare().unwrap();
    // 3 m in 2 s = 1.5 m/s > the 0.8 m/s dock limit.
    let too_fast = fixture_response(&prepared, [-3.0, 0.0, 1.0]);
    assert!(prepared
        .accept_json(&serde_json::to_vec(&too_fast).unwrap())
        .is_err());
}

#[test]
fn a_local_snapshot_file_cannot_build_a_scene() {
    let mut file = SpacesSnapshot::from_json(&api_response(data("anonymous", -6.0))).unwrap();
    file.source_hash = None; // what a snapshot loaded from a plain file looks like
    assert!(physical_scene_from_snapshot(&file, &options()).is_err());
}

#[test]
fn a_tampered_response_is_refused_before_any_scene_exists() {
    let mut value: Value = serde_json::from_slice(&api_response(data("anonymous", -6.0))).unwrap();
    value["data"]["entities"][0]["placement"]["centerM"][0] = json!(-1.0);
    assert!(SpacesSnapshot::from_json(&serde_json::to_vec(&value).unwrap()).is_err());
}

#[test]
fn people_who_are_not_anonymous_are_left_out_and_an_empty_scene_is_an_error() {
    let snapshot = SpacesSnapshot::from_json(&api_response(data("named", -6.0))).unwrap();
    // The only person is not anonymous, so nothing can be projected.
    assert!(physical_scene_from_snapshot(&snapshot, &options()).is_err());
}

#[test]
fn a_person_inside_an_object_is_refused_at_projection() {
    let snapshot = SpacesSnapshot::from_json(&api_response(data("anonymous", 5.0))).unwrap();
    let built = physical_scene_from_snapshot(&snapshot, &options()).unwrap();
    assert!(built.prepare().is_err());
}
