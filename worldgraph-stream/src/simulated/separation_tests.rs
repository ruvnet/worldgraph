//! Tests that the simulated channel and the twin stream never mix.

use std::sync::Arc;

use axum::http::StatusCode;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::time::{timeout, Duration};
use tokio_tungstenite::tungstenite::Message;
use wifi_densepose_geo::GeoRegistration;
use wifi_densepose_worldgraph::{WorldGraph, WorldId};

use super::tests::{assert_error, body, FakeValidator, Harness};
use crate::{
    server::{router, StreamHub},
    TwinEnvelope, TwinMessage,
};

#[tokio::test]
async fn twin_and_simulated_envelopes_are_not_interchangeable() {
    let h = Harness::spawn().await;
    let twin = TwinEnvelope::new("sim-test", 1, TwinMessage::RemoveNode { id: WorldId(99) });
    let twin = serde_json::to_value(&twin).unwrap();

    // A twin envelope on the simulated route is rejected and stored nowhere.
    let response = h.publish(Some("writer"), &twin).await;
    assert_error(
        &response,
        StatusCode::UNPROCESSABLE_ENTITY,
        "not a SimulatedFrameEnvelope",
    );
    assert!(h.store.sessions().is_empty());

    // A simulated envelope on the twin route is rejected and applied nowhere.
    let simulated = serde_json::to_vec(&body("alpha", 0, 1)).unwrap();
    let (status, _) = h
        .post_raw("/v1/twin/envelopes", Some("writer"), simulated)
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(h.store.sessions().is_empty());

    // The twin stream is still at sequence zero: the same twin envelope with
    // seq 1 is accepted on its own route (it would conflict had seq advanced).
    let (status, _) = h
        .post_raw(
            "/v1/twin/envelopes",
            Some("writer"),
            serde_json::to_vec(&twin).unwrap(),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert!(h.store.sessions().is_empty());
}

async fn next_json<S>(ws: &mut tokio_tungstenite::WebSocketStream<S>) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let frame = timeout(Duration::from_secs(2), ws.next()).await.unwrap();
    serde_json::from_str(&frame.unwrap().unwrap().into_text().unwrap()).unwrap()
}

#[tokio::test]
async fn simulated_publish_never_reaches_twin_subscribers() {
    let h = Harness::spawn().await;
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{}/v1/twin/ws", h.addr))
        .await
        .unwrap();
    let hello = json!({
        "type": "client_hello", "supported_protocol_versions": [1],
        "capabilities": ["snapshot", "delta", "presence"], "access_token": "reader"
    });
    ws.send(Message::Text(hello.to_string().into()))
        .await
        .unwrap();
    assert_eq!(next_json(&mut ws).await["type"], "server_hello");
    assert_eq!(next_json(&mut ws).await["message"]["op"], "snapshot");

    for sequence in 0..3 {
        let (status, _) = h.publish(Some("writer"), &body("alpha", 0, sequence)).await;
        assert_eq!(status, StatusCode::ACCEPTED);
    }
    assert_eq!(h.store.sessions()[0].envelope_count, 3);
    let silence = timeout(Duration::from_millis(400), ws.next()).await;
    assert!(silence.is_err(), "twin subscriber received {silence:?}");

    // The subscriber is live and the hub untouched: the first twin delta is
    // the very next frame and takes sequence 1.
    h.hub
        .publish(TwinEnvelope::new(
            "sim-test",
            1,
            TwinMessage::UpsertNode {
                node: wifi_densepose_worldgraph::WorldNode::Room {
                    id: WorldId(1),
                    area_id: None,
                    name: "Real".into(),
                    bounds_enu: wifi_densepose_worldgraph::ZoneBoundsEnu::Rectangle {
                        min_e: 0.0,
                        min_n: 0.0,
                        max_e: 1.0,
                        max_n: 1.0,
                    },
                    floor: 0,
                },
            },
        ))
        .await
        .unwrap();
    let delta = next_json(&mut ws).await;
    assert_eq!(delta["message"]["op"], "upsert_node");
    assert_eq!(delta["seq"], 1);
}

#[tokio::test]
async fn default_router_serves_the_simulated_routes() {
    let hub = StreamHub::new("d", WorldGraph::new(GeoRegistration::default()).snapshot());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = router(hub, Arc::new(FakeValidator));
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = reqwest::Client::new();
    let health = client
        .get(format!("http://{addr}/healthz"))
        .send()
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);
    let sessions: Value = client
        .get(format!("http://{addr}/v1/sim/sessions"))
        .bearer_auth("reader")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(sessions, json!({"sessions": []}));
    task.abort();
}
