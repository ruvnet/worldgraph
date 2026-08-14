//! Standalone authenticated WorldGraph stream server.

use std::{
    env,
    net::SocketAddr,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use wifi_densepose_geo::GeoRegistration;
use wifi_densepose_worldgraph::{
    EnuPoint, SensorModality, WorldEdge, WorldEdgeId, WorldGraph, WorldId, WorldNode, ZoneBoundsEnu,
};
use worldgraph_stream::{
    server::{self, DemoBootstrap, JwtTokenValidator, StreamHub},
    TwinEnvelope, TwinMessage,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bind: SocketAddr = env::var("WORLDGRAPH_BIND")
        .unwrap_or_else(|_| "0.0.0.0:8080".into())
        .parse()?;
    let secret = env::var("WORLDGRAPH_TOKEN_SECRET")
        .map_err(|_| "WORLDGRAPH_TOKEN_SECRET is required and must contain at least 32 bytes")?;
    let audience =
        env::var("WORLDGRAPH_TOKEN_AUDIENCE").unwrap_or_else(|_| "worldgraph-stream".into());
    let validator = Arc::new(JwtTokenValidator::new(secret.as_bytes(), &audience)?);
    let epoch = format!(
        "boot-{}",
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs()
    );
    let demo_mode = env::var("WORLDGRAPH_DEMO_MODE").is_ok_and(|value| value == "1");
    let graph = if demo_mode {
        demo_graph()
    } else {
        WorldGraph::new(GeoRegistration::default())
    };
    let hub = StreamHub::new(epoch.clone(), graph.snapshot());
    if demo_mode {
        spawn_demo_updates(hub.clone(), epoch);
        let demo = DemoBootstrap::new(secret.as_bytes(), audience, 120)?;
        server::serve_with_demo(bind, hub, validator, demo).await?;
    } else {
        server::serve(bind, hub, validator).await?;
    }
    Ok(())
}

fn demo_graph() -> WorldGraph {
    let mut graph = WorldGraph::new(GeoRegistration::default());
    graph.upsert_node(WorldNode::Room {
        id: WorldId(1),
        area_id: Some("demo-room".into()),
        name: "Live Demo Room".into(),
        bounds_enu: ZoneBoundsEnu::Rectangle {
            min_e: 0.0,
            min_n: 0.0,
            max_e: 8.0,
            max_n: 6.0,
        },
        floor: 0,
    });
    graph.upsert_node(WorldNode::Sensor {
        id: WorldId(2),
        device_id: "demo-csi".into(),
        position: EnuPoint {
            east_m: 1.0,
            north_m: 1.0,
            up_m: 1.5,
        },
        modality: SensorModality::WifiCsi,
    });
    graph.upsert_node(demo_person(0));
    graph
        .upsert_edge(
            WorldEdgeId(1),
            WorldId(3),
            WorldId(1),
            WorldEdge::LocatedIn { since_unix_ms: 0 },
        )
        .expect("demo endpoints exist");
    graph
        .upsert_edge(
            WorldEdgeId(2),
            WorldId(2),
            WorldId(3),
            WorldEdge::Observes {
                quality: 0.95,
                last_seen_unix_ms: 0,
            },
        )
        .expect("demo endpoints exist");
    graph
}

fn demo_person(step: u64) -> WorldNode {
    let phase = (step % 32) as f64;
    let east_m = if phase <= 16.0 {
        1.5 + phase * 0.3
    } else {
        1.5 + (32.0 - phase) * 0.3
    };
    WorldNode::PersonTrack {
        id: WorldId(3),
        track_id: 1,
        last_position: EnuPoint {
            east_m,
            north_m: 3.0,
            up_m: 0.0,
        },
        reid_embedding_ref: None,
    }
}

fn spawn_demo_updates(hub: StreamHub, epoch: String) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(500));
        let mut seq = 1_u64;
        loop {
            interval.tick().await;
            if hub
                .publish(TwinEnvelope::new(
                    &epoch,
                    seq,
                    TwinMessage::UpsertNode {
                        node: demo_person(seq),
                    },
                ))
                .await
                .is_err()
            {
                break;
            }
            seq = seq.saturating_add(1);
        }
    });
}
