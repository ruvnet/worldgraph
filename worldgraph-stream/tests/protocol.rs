//! Replication, migration, privacy, and wire-contract integration tests.

use std::collections::HashSet;

use wifi_densepose_geo::GeoRegistration;
use wifi_densepose_worldgraph::{
    EnuPoint, SensorModality, WorldEdge, WorldEdgeId, WorldGraph, WorldId, WorldNode,
    ZoneBoundsEnu, SCHEMA_VERSION,
};
use worldgraph_stream::{
    AccessProjector, ApplyError, ApplyOutcome, DefaultAccessPolicy, TwinEnvelope, TwinMessage,
    TwinReplica, ViewerClaims,
};

fn room(id: u64) -> WorldNode {
    WorldNode::Room {
        id: WorldId(id),
        area_id: None,
        name: format!("room-{id}"),
        bounds_enu: ZoneBoundsEnu::Rectangle {
            min_e: 0.0,
            min_n: 0.0,
            max_e: 1.0,
            max_n: 1.0,
        },
        floor: 0,
    }
}
fn person(id: u64) -> WorldNode {
    WorldNode::PersonTrack {
        id: WorldId(id),
        track_id: id,
        last_position: EnuPoint {
            east_m: 0.0,
            north_m: 0.0,
            up_m: 0.0,
        },
        reid_embedding_ref: None,
    }
}
fn sensor(id: u64) -> WorldNode {
    WorldNode::Sensor {
        id: WorldId(id),
        device_id: "s".into(),
        position: EnuPoint {
            east_m: 0.0,
            north_m: 0.0,
            up_m: 0.0,
        },
        modality: SensorModality::WifiCsi,
    }
}
fn snapshot(epoch: &str, graph: &WorldGraph) -> TwinEnvelope {
    TwinEnvelope::new(
        epoch,
        0,
        TwinMessage::Snapshot {
            graph_schema_version: SCHEMA_VERSION,
            rvf_json: String::from_utf8(graph.to_json().unwrap()).unwrap(),
        },
    )
}

#[test]
fn wire_shape_matches_browser_contract() {
    let value = serde_json::to_value(TwinEnvelope::new(
        "e",
        7,
        TwinMessage::RemoveEdge { id: WorldEdgeId(4) },
    ))
    .unwrap();
    assert_eq!(value["stream_epoch"], "e");
    assert_eq!(value["message"]["op"], "remove_edge");
    assert_eq!(value["message"]["id"], 4);
    assert!(value.get("epoch").is_none());
}

#[test]
fn replay_is_idempotent_and_replaces_and_removes_edges() {
    let mut source = WorldGraph::new(GeoRegistration::default());
    source.upsert_node(room(1));
    source.upsert_node(sensor(2));
    let mut replica = TwinReplica::default();
    assert_eq!(
        replica.apply(snapshot("a", &source)).unwrap(),
        ApplyOutcome::Applied
    );
    let upsert = TwinEnvelope::new(
        "a",
        1,
        TwinMessage::UpsertEdge {
            id: WorldEdgeId(9),
            from: WorldId(2),
            to: WorldId(1),
            edge: WorldEdge::Observes {
                quality: 0.2,
                last_seen_unix_ms: 1,
            },
        },
    );
    replica.apply(upsert.clone()).unwrap();
    assert_eq!(replica.apply(upsert).unwrap(), ApplyOutcome::Duplicate);
    assert_eq!(replica.graph().unwrap().edge_count(), 1);
    replica
        .apply(TwinEnvelope::new(
            "a",
            2,
            TwinMessage::UpsertEdge {
                id: WorldEdgeId(9),
                from: WorldId(2),
                to: WorldId(1),
                edge: WorldEdge::Observes {
                    quality: 0.9,
                    last_seen_unix_ms: 2,
                },
            },
        ))
        .unwrap();
    assert_eq!(replica.graph().unwrap().edge_count(), 1);
    replica
        .apply(TwinEnvelope::new(
            "a",
            3,
            TwinMessage::RemoveEdge { id: WorldEdgeId(9) },
        ))
        .unwrap();
    assert_eq!(replica.graph().unwrap().edge_count(), 0);
}

#[test]
fn sequence_gap_and_epoch_change_require_snapshot() {
    let graph = WorldGraph::new(GeoRegistration::default());
    let mut replica = TwinReplica::default();
    replica.apply(snapshot("a", &graph)).unwrap();
    assert!(matches!(
        replica.apply(TwinEnvelope::new(
            "a",
            2,
            TwinMessage::RemoveNode { id: WorldId(1) }
        )),
        Err(ApplyError::SequenceGap { .. })
    ));
    assert!(matches!(
        replica.apply(TwinEnvelope::new(
            "b",
            0,
            TwinMessage::RemoveNode { id: WorldId(1) }
        )),
        Err(ApplyError::EpochRequiresSnapshot { .. })
    ));
}

#[test]
fn projection_filters_sensitive_nodes_closes_edges_and_resequences() {
    let mut graph = WorldGraph::new(GeoRegistration::default());
    graph.upsert_node(room(1));
    graph.upsert_node(sensor(2));
    graph.upsert_node(person(3));
    graph
        .upsert_edge(
            WorldEdgeId(4),
            WorldId(2),
            WorldId(1),
            WorldEdge::Observes {
                quality: 1.0,
                last_seen_unix_ms: 0,
            },
        )
        .unwrap();
    graph
        .upsert_edge(
            WorldEdgeId(5),
            WorldId(2),
            WorldId(3),
            WorldEdge::Observes {
                quality: 1.0,
                last_seen_unix_ms: 0,
            },
        )
        .unwrap();
    let claims = ViewerClaims {
        subject: "viewer".into(),
        scopes: HashSet::from(["twin:read".into()]),
        expires_at: 99,
    };
    let mut p = AccessProjector::new(DefaultAccessPolicy, claims);
    let projected = p.project(snapshot("a", &graph)).unwrap();
    let TwinMessage::Snapshot { rvf_json, .. } = projected.message else {
        panic!()
    };
    let visible = WorldGraph::from_json(rvf_json.as_bytes()).unwrap();
    assert!(visible.node(WorldId(3)).is_none());
    assert_eq!(visible.edge_count(), 1);
    // A hidden update emits nothing and does not consume viewer sequence 1.
    assert!(p
        .project(TwinEnvelope::new(
            "a",
            8,
            TwinMessage::UpsertNode { node: person(3) }
        ))
        .is_none());
    let next = p
        .project(TwinEnvelope::new(
            "a",
            9,
            TwinMessage::RemoveEdge { id: WorldEdgeId(4) },
        ))
        .unwrap();
    assert_eq!(next.seq, 1);
    // Removing an edge that was never visible leaks nothing.
    assert!(p
        .project(TwinEnvelope::new(
            "a",
            10,
            TwinMessage::RemoveEdge { id: WorldEdgeId(5) }
        ))
        .is_none());
}

#[test]
fn formerly_visible_edge_becoming_hidden_projects_removal() {
    let mut graph = WorldGraph::new(GeoRegistration::default());
    graph.upsert_node(room(1));
    graph.upsert_node(sensor(2));
    graph.upsert_node(person(3));
    graph
        .upsert_edge(
            WorldEdgeId(7),
            WorldId(2),
            WorldId(1),
            WorldEdge::Supports { strength: 1.0 },
        )
        .unwrap();
    let claims = ViewerClaims {
        subject: "viewer".into(),
        scopes: HashSet::from(["twin:read".into()]),
        expires_at: 99,
    };
    let mut p = AccessProjector::new(DefaultAccessPolicy, claims);
    p.project(snapshot("a", &graph)).unwrap();
    let out = p
        .project(TwinEnvelope::new(
            "a",
            1,
            TwinMessage::UpsertEdge {
                id: WorldEdgeId(7),
                from: WorldId(2),
                to: WorldId(3),
                edge: WorldEdge::Supports { strength: 0.5 },
            },
        ))
        .unwrap();
    assert!(matches!(
        out.message,
        TwinMessage::RemoveEdge { id: WorldEdgeId(7) }
    ));
}

#[test]
fn legacy_v1_snapshot_is_migrated_during_replica_and_projection() {
    let mut graph = WorldGraph::new(GeoRegistration::default());
    graph.upsert_node(room(1));
    graph.upsert_node(sensor(2));
    graph
        .upsert_edge(
            WorldEdgeId(8),
            WorldId(2),
            WorldId(1),
            WorldEdge::Supports { strength: 1.0 },
        )
        .unwrap();
    let mut value = serde_json::to_value(graph.snapshot()).unwrap();
    value["schema_version"] = 1.into();
    value.as_object_mut().unwrap().remove("next_edge_id");
    let records = value["edges"].as_array().unwrap().clone();
    value["edges"] = records
        .into_iter()
        .map(|r| serde_json::json!([r["from"], r["to"], r["edge"]]))
        .collect::<Vec<_>>()
        .into();
    let rvf_json = serde_json::to_string(&value).unwrap();
    let env = TwinEnvelope::new(
        "old",
        0,
        TwinMessage::Snapshot {
            graph_schema_version: 1,
            rvf_json,
        },
    );
    let mut replica = TwinReplica::default();
    replica.apply(env.clone()).unwrap();
    assert_eq!(replica.graph().unwrap().edge_count(), 1);
    let claims = ViewerClaims {
        subject: "v".into(),
        scopes: HashSet::from(["twin:read".into()]),
        expires_at: 99,
    };
    let out = AccessProjector::new(DefaultAccessPolicy, claims)
        .project(env)
        .unwrap();
    assert!(matches!(
        out.message,
        TwinMessage::Snapshot {
            graph_schema_version: SCHEMA_VERSION,
            ..
        }
    ));
}

#[test]
fn refreshed_claims_preserve_projected_sequence_and_rebuild_visibility() {
    let mut graph = WorldGraph::new(GeoRegistration::default());
    graph.upsert_node(room(1));
    graph.upsert_node(person(3));
    let basic = ViewerClaims {
        subject: "v".into(),
        scopes: HashSet::from(["twin:read".into()]),
        expires_at: 9,
    };
    let mut projector = AccessProjector::new(DefaultAccessPolicy, basic);
    projector.project(snapshot("e", &graph)).unwrap();
    let visible = projector
        .project(TwinEnvelope::new(
            "e",
            1,
            TwinMessage::UpsertNode { node: room(1) },
        ))
        .unwrap();
    assert_eq!(visible.seq, 1);
    projector.replace_claims(ViewerClaims {
        subject: "v".into(),
        scopes: HashSet::from(["twin:read".into(), "twin:sensitive".into()]),
        expires_at: 99,
    });
    let refreshed = projector.project(snapshot("e", &graph)).unwrap();
    assert_eq!(refreshed.seq, 2);
    let TwinMessage::Snapshot { rvf_json, .. } = refreshed.message else {
        panic!()
    };
    assert!(WorldGraph::from_json(rvf_json.as_bytes())
        .unwrap()
        .node(WorldId(3))
        .is_some());
}
