//! End-to-end tests for the `/v1/sim/` routes over a real listener.

use std::{net::SocketAddr, sync::Arc};

use axum::http::{header::CONTENT_TYPE, StatusCode};
use serde_json::{json, Value};
use wifi_densepose_geo::GeoRegistration;
use wifi_densepose_worldgraph::WorldGraph;

use super::{
    fixtures::envelope, SimulatedStore, MAX_ENVELOPES_PER_SESSION, MAX_LIST_LIMIT, MAX_SESSIONS,
    MAX_SIMULATED_ENVELOPE_BYTES,
};
use crate::{
    server::{router_with_simulated, AuthError, StreamHub, TokenValidator},
    ViewerClaims,
};

/// Stand-in identity provider: the token names the single scope it grants.
pub(super) struct FakeValidator;
impl TokenValidator for FakeValidator {
    fn validate(&self, token: &str, now: u64) -> Result<ViewerClaims, AuthError> {
        let scope = match token {
            "writer" => "twin:write",
            "reader" => "twin:read",
            _ => return Err(AuthError::Invalid),
        };
        Ok(ViewerClaims {
            subject: token.into(),
            scopes: [scope.into()].into(),
            expires_at: now + 60,
        })
    }
}

pub(super) struct Harness {
    pub(super) addr: SocketAddr,
    pub(super) hub: StreamHub,
    pub(super) store: SimulatedStore,
    client: reqwest::Client,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Harness {
    pub(super) async fn spawn() -> Self {
        let hub = StreamHub::new(
            "sim-test",
            WorldGraph::new(GeoRegistration::default()).snapshot(),
        );
        let store = SimulatedStore::new();
        let app = router_with_simulated(hub.clone(), Arc::new(FakeValidator), None, store.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            addr,
            hub,
            store,
            client: reqwest::Client::new(),
            task,
        }
    }

    async fn send(
        &self,
        request: reqwest::RequestBuilder,
        token: Option<&str>,
    ) -> (StatusCode, Value) {
        let request = match token {
            Some(token) => request.bearer_auth(token),
            None => request,
        };
        let response = request.send().await.unwrap();
        let status = response.status();
        let text = response.text().await.unwrap();
        (
            status,
            serde_json::from_str(&text).unwrap_or(Value::String(text)),
        )
    }

    /// POST raw bytes as JSON to `path`.
    pub(super) async fn post_raw(
        &self,
        path: &str,
        token: Option<&str>,
        body: Vec<u8>,
    ) -> (StatusCode, Value) {
        let request = self
            .client
            .post(format!("http://{}{path}", self.addr))
            .header(CONTENT_TYPE, "application/json")
            .body(body);
        self.send(request, token).await
    }

    pub(super) async fn publish(&self, token: Option<&str>, body: &Value) -> (StatusCode, Value) {
        self.post_raw(
            "/v1/sim/envelopes",
            token,
            serde_json::to_vec(body).unwrap(),
        )
        .await
    }

    async fn get(&self, path: &str, token: Option<&str>) -> (StatusCode, Value) {
        let request = self.client.get(format!("http://{}{path}", self.addr));
        self.send(request, token).await
    }
}

type Mutation = Box<dyn Fn(&mut Value)>;

pub(super) fn body(session_id: &str, epoch: u64, sequence: u64) -> Value {
    serde_json::to_value(envelope(session_id, epoch, sequence)).unwrap()
}

pub(super) fn assert_error(response: &(StatusCode, Value), status: StatusCode, needle: &str) {
    assert_eq!(response.0, status, "{}", response.1);
    let message = response.1["error"]
        .as_str()
        .unwrap_or_else(|| panic!("no JSON error body: {}", response.1));
    assert!(message.contains(needle), "{message:?} lacks {needle:?}");
}

#[tokio::test]
async fn publishes_then_lists_envelopes_and_sessions() {
    let h = Harness::spawn().await;
    for sequence in 0..3 {
        let (status, receipt) = h.publish(Some("writer"), &body("alpha", 4, sequence)).await;
        assert_eq!(status, StatusCode::ACCEPTED);
        assert_eq!(
            receipt,
            json!({"accepted": true, "session_id": "alpha", "epoch": 4, "sequence": sequence})
        );
    }
    h.publish(Some("writer"), &body("beta", 0, 9)).await;

    let (status, listed) = h
        .get("/v1/sim/envelopes?session_id=alpha", Some("reader"))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["session_id"], "alpha");
    assert_eq!(listed["count"], 3);
    let sequences: Vec<_> = listed["envelopes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["sequence"].as_u64().unwrap())
        .collect();
    assert_eq!(sequences, [0, 1, 2], "oldest first");
    // The stored envelope round-trips unchanged: descriptors and provenance only.
    assert_eq!(listed["envelopes"][0], body("alpha", 4, 0));

    let (_, page) = h
        .get(
            "/v1/sim/envelopes?session_id=alpha&after_sequence=0&limit=1",
            Some("reader"),
        )
        .await;
    assert_eq!(page["count"], 1);
    assert_eq!(page["envelopes"][0]["sequence"], 1);
    let (_, unknown) = h
        .get("/v1/sim/envelopes?session_id=nope", Some("reader"))
        .await;
    assert_eq!(unknown["count"], 0);

    let (status, sessions) = h.get("/v1/sim/sessions", Some("reader")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        sessions,
        json!({"sessions": [
            {"session_id": "alpha", "epoch": 4, "sequence": 2, "envelope_count": 3},
            {"session_id": "beta", "epoch": 0, "sequence": 9, "envelope_count": 1},
        ]})
    );
}

#[tokio::test]
async fn every_route_requires_a_valid_token_with_the_right_scope() {
    let h = Harness::spawn().await;
    // Publishing needs twin:write; a reader, a bad token, and no token all fail.
    for token in [None, Some("forged"), Some("reader")] {
        let response = h.publish(token, &body("alpha", 0, 0)).await;
        assert_error(&response, StatusCode::UNAUTHORIZED, "twin:write");
    }
    assert!(h.store.sessions().is_empty(), "nothing stored without auth");
    // An unauthenticated caller learns nothing about the body either.
    let response = h
        .post_raw("/v1/sim/envelopes", None, b"not json".to_vec())
        .await;
    assert_error(&response, StatusCode::UNAUTHORIZED, "twin:write");

    // Reading needs twin:read; a writer-only token is not enough.
    for path in ["/v1/sim/envelopes?session_id=alpha", "/v1/sim/sessions"] {
        for token in [None, Some("forged"), Some("writer")] {
            let response = h.get(path, token).await;
            assert_error(&response, StatusCode::UNAUTHORIZED, "twin:read");
        }
    }
}

#[tokio::test]
async fn rejects_invalid_envelopes_with_json_errors() {
    let h = Harness::spawn().await;
    let unprocessable = StatusCode::UNPROCESSABLE_ENTITY;
    let frame = body("alpha", 0, 0)["chunk"]["frames"][0].clone();
    let tiny = json!({"transport": "s", "locator": "l", "content_hash": "h",
                      "byte_length": 1, "media_type": "m"});
    let cases: Vec<(&str, Mutation, &str)> = vec![
        (
            "schema",
            Box::new(|b| b["schema_version"] = json!(2)),
            "schema_version",
        ),
        (
            "not simulated",
            Box::new(|b| b["chunk"]["provenance"]["simulated"] = json!(false)),
            "simulated must be true",
        ),
        (
            "confidence high",
            Box::new(|b| b["chunk"]["provenance"]["confidence"] = json!(1.5)),
            "confidence",
        ),
        (
            "confidence negative",
            Box::new(|b| b["chunk"]["provenance"]["confidence"] = json!(-0.1)),
            "confidence",
        ),
        (
            "empty session",
            Box::new(|b| b["session_id"] = json!("")),
            "session_id",
        ),
        (
            "long session",
            Box::new(|b| b["session_id"] = json!("x".repeat(129))),
            "session_id",
        ),
        (
            "too many frames",
            Box::new(move |b| b["chunk"]["frames"] = json!(vec![tiny.clone(); 1_025])),
            "frame descriptors",
        ),
        (
            "credentialed locator",
            Box::new(move |b| {
                let mut second = frame.clone();
                second["locator"] = json!("https://user:pw@media.example/f");
                b["chunk"]["frames"].as_array_mut().unwrap().push(second);
            }),
            "frames[1].locator must not contain credentials",
        ),
    ];
    for (name, mutate, needle) in cases {
        let mut bad = body("alpha", 0, 0);
        mutate(&mut bad);
        assert!(
            serde_json::to_vec(&bad).unwrap().len() < MAX_SIMULATED_ENVELOPE_BYTES,
            "{name}: must fail on content, not size"
        );
        let response = h.publish(Some("writer"), &bad).await;
        assert_error(&response, unprocessable, needle);
    }

    // JSON has no NaN/Infinity literal; an out-of-range number becomes an
    // infinite f32 on the way in and must still be rejected.
    let overflow = serde_json::to_string(&body("alpha", 0, 0))
        .unwrap()
        .replace("\"confidence\":0.5", "\"confidence\":1e40");
    assert!(overflow.contains("1e40"));
    let response = h
        .post_raw("/v1/sim/envelopes", Some("writer"), overflow.into_bytes())
        .await;
    assert_error(&response, unprocessable, "confidence");

    let response = h
        .post_raw("/v1/sim/envelopes", Some("writer"), b"{not json".to_vec())
        .await;
    assert_error(&response, StatusCode::BAD_REQUEST, "malformed JSON");
    let request = h
        .client
        .post(format!("http://{}/v1/sim/envelopes", h.addr))
        .header(CONTENT_TYPE, "text/plain")
        .body(serde_json::to_vec(&body("alpha", 0, 0)).unwrap());
    let response = h.send(request, Some("writer")).await;
    assert_error(
        &response,
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "application/json",
    );

    assert!(
        h.store.sessions().is_empty(),
        "no rejected envelope was stored"
    );
}

#[tokio::test]
async fn enforces_the_256_kib_body_bound_exactly() {
    let h = Harness::spawn().await;
    assert_eq!(MAX_SIMULATED_ENVELOPE_BYTES, 256 * 1024);
    let padded = |sequence: u64, len: usize| {
        let mut bytes = serde_json::to_vec(&body("alpha", 0, sequence)).unwrap();
        bytes.resize(len, b' ');
        bytes
    };
    let at_limit = padded(0, MAX_SIMULATED_ENVELOPE_BYTES);
    let (status, _) = h
        .post_raw("/v1/sim/envelopes", Some("writer"), at_limit)
        .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let over = padded(1, MAX_SIMULATED_ENVELOPE_BYTES + 1);
    let response = h.post_raw("/v1/sim/envelopes", Some("writer"), over).await;
    assert_error(&response, StatusCode::PAYLOAD_TOO_LARGE, "262144 bytes");
    assert_eq!(h.store.sessions()[0].sequence, 0);
}

#[tokio::test]
async fn duplicate_and_out_of_order_positions_conflict() {
    let h = Harness::spawn().await;
    let accepted = StatusCode::ACCEPTED;
    assert_eq!(
        h.publish(Some("writer"), &body("alpha", 1, 5)).await.0,
        accepted
    );
    for (epoch, sequence) in [(1, 5), (1, 4), (0, 6)] {
        let response = h
            .publish(Some("writer"), &body("alpha", epoch, sequence))
            .await;
        assert_error(
            &response,
            StatusCode::CONFLICT,
            "is not after epoch 1 sequence 5",
        );
    }
    // A later sequence, a later epoch restarting at zero, and another session
    // reusing an old position are all fine.
    for (session, epoch, sequence) in [("alpha", 1, 6), ("alpha", 2, 0), ("beta", 1, 5)] {
        let (status, _) = h
            .publish(Some("writer"), &body(session, epoch, sequence))
            .await;
        assert_eq!(status, accepted, "{session} {epoch} {sequence}");
    }
    let (_, listed) = h
        .get(
            "/v1/sim/envelopes?session_id=alpha&after_epoch=1&after_sequence=5",
            Some("reader"),
        )
        .await;
    assert_eq!(listed["count"], 2);
    assert_eq!(listed["envelopes"][1]["epoch"], 2);
}

#[tokio::test]
async fn list_validates_its_query_and_clamps_the_limit() {
    let h = Harness::spawn().await;
    let bad_request = StatusCode::BAD_REQUEST;
    let long = format!("/v1/sim/envelopes?session_id={}", "x".repeat(129));
    for (path, needle) in [
        ("/v1/sim/envelopes", "session_id is required"),
        (
            "/v1/sim/envelopes?after_sequence=1",
            "session_id is required",
        ),
        ("/v1/sim/envelopes?session_id=", "session_id must contain"),
        (long.as_str(), "session_id must contain"),
        ("/v1/sim/envelopes?session_id=a&limit=many", "invalid query"),
        (
            "/v1/sim/envelopes?session_id=a&after_sequence=-1",
            "invalid query",
        ),
    ] {
        assert_error(&h.get(path, Some("reader")).await, bad_request, needle);
    }

    for sequence in 0..=MAX_LIST_LIMIT as u64 + 10 {
        h.store.publish(envelope("alpha", 0, sequence)).unwrap();
    }
    let (_, default) = h
        .get("/v1/sim/envelopes?session_id=alpha", Some("reader"))
        .await;
    assert_eq!(default["count"], 50);
    let (_, clamped) = h
        .get(
            "/v1/sim/envelopes?session_id=alpha&limit=5000",
            Some("reader"),
        )
        .await;
    assert_eq!(clamped["count"], MAX_LIST_LIMIT);
    assert_eq!(clamped["envelopes"][0]["sequence"], 0);
}

#[tokio::test]
async fn store_bounds_hold_over_http() {
    let h = Harness::spawn().await;
    for sequence in 0..MAX_ENVELOPES_PER_SESSION as u64 + 3 {
        let (status, _) = h.publish(Some("writer"), &body("s0", 0, sequence)).await;
        assert_eq!(status, StatusCode::ACCEPTED);
    }
    for index in 1..=MAX_SESSIONS {
        h.publish(Some("writer"), &body(&format!("s{index}"), 0, 0))
            .await;
    }
    let (_, sessions) = h.get("/v1/sim/sessions", Some("reader")).await;
    let sessions = sessions["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), MAX_SESSIONS);
    assert_eq!(
        sessions[0]["session_id"], "s1",
        "first-created session evicted"
    );
    assert!(sessions.iter().all(|s| s["envelope_count"] == 1));

    // Per-session bound, and replay of an evicted envelope still conflicts.
    for sequence in 1..MAX_ENVELOPES_PER_SESSION as u64 + 3 {
        h.publish(Some("writer"), &body("s9", 0, sequence)).await;
    }
    let summary = h
        .store
        .sessions()
        .into_iter()
        .find(|s| s.session_id == "s9");
    assert_eq!(summary.unwrap().envelope_count, MAX_ENVELOPES_PER_SESSION);
    let response = h.publish(Some("writer"), &body("s9", 0, 0)).await;
    assert_error(&response, StatusCode::CONFLICT, "is not after");
}
