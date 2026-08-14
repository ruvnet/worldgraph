//! Optional Axum WebSocket server and short-lived JWT validation seam.

use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{
        ws::{Message, WebSocket},
        DefaultBodyLimit, State, WebSocketUpgrade,
    },
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use tokio::{
    sync::{broadcast, Mutex, RwLock},
    time::{timeout, Duration},
};
use wifi_densepose_worldgraph::{EnuPoint, WorldGraphSnapshot, SCHEMA_VERSION};

use crate::{
    AccessProjector, DefaultAccessPolicy, PresenceUpdate, TwinEnvelope, TwinMessage, TwinReplica,
    ViewerClaims, PROTOCOL_VERSION,
};

/// Maximum accepted remaining token lifetime.
pub const MAX_TOKEN_TTL_SECONDS: u64 = 300;
/// Maximum handshake/control or publish payload.
pub const MAX_MESSAGE_BYTES: usize = 256 * 1024;

/// Authentication validation failure.
#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    /// Token signature, claims, lifetime, or audience is invalid.
    #[error("invalid bearer token")]
    Invalid,
}

/// Replaceable authentication seam for production identity providers.
pub trait TokenValidator: Send + Sync {
    /// Validate a token at `now_unix` and return trusted claims.
    fn validate(&self, token: &str, now_unix: u64) -> Result<ViewerClaims, AuthError>;
}

#[derive(Debug, Deserialize)]
struct JwtClaims {
    sub: String,
    exp: u64,
    #[serde(default)]
    scope: String,
}

/// Audience-bound HS256 validator.
pub struct JwtTokenValidator {
    key: DecodingKey,
    validation: Validation,
}
impl JwtTokenValidator {
    /// Secrets shorter than 32 bytes and empty audiences are rejected.
    pub fn new(secret: &[u8], audience: &str) -> Result<Self, AuthError> {
        if secret.len() < 32 || audience.is_empty() {
            return Err(AuthError::Invalid);
        }
        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_audience(&[audience]);
        validation.validate_exp = true;
        validation.leeway = 0;
        Ok(Self {
            key: DecodingKey::from_secret(secret),
            validation,
        })
    }
}
impl TokenValidator for JwtTokenValidator {
    fn validate(&self, token: &str, now: u64) -> Result<ViewerClaims, AuthError> {
        let c = jsonwebtoken::decode::<JwtClaims>(token, &self.key, &self.validation)
            .map_err(|_| AuthError::Invalid)?
            .claims;
        if c.exp <= now || c.exp.saturating_sub(now) > MAX_TOKEN_TTL_SECONDS {
            return Err(AuthError::Invalid);
        }
        Ok(ViewerClaims {
            subject: c.sub,
            scopes: c
                .scope
                .split_ascii_whitespace()
                .map(str::to_owned)
                .collect(),
            expires_at: c.exp,
        })
    }
}

/// Validated authoritative state and fanout channel.
#[derive(Clone)]
pub struct StreamHub {
    snapshot: Arc<RwLock<TwinEnvelope>>,
    replica: Arc<Mutex<TwinReplica>>,
    tx: broadcast::Sender<TwinEnvelope>,
    presence_tx: broadcast::Sender<Vec<PresenceUpdate>>,
    presence: Arc<RwLock<HashMap<u64, EnuPoint>>>,
    next_viewer: Arc<AtomicU64>,
}
impl StreamHub {
    /// Create a hub with an authoritative initial snapshot.
    #[must_use]
    pub fn new(epoch: impl Into<String>, snapshot: WorldGraphSnapshot) -> Self {
        let epoch = epoch.into();
        let rvf_json = serde_json::to_string(&snapshot).expect("snapshot serialization");
        let initial = TwinEnvelope::new(
            epoch,
            0,
            TwinMessage::Snapshot {
                graph_schema_version: snapshot.schema_version,
                rvf_json,
            },
        );
        let mut replica = TwinReplica::default();
        replica
            .apply(initial.clone())
            .expect("locally-created snapshot is valid");
        let (tx, _) = broadcast::channel(256);
        let (presence_tx, _) = broadcast::channel(256);
        Self {
            snapshot: Arc::new(RwLock::new(initial)),
            replica: Arc::new(Mutex::new(replica)),
            tx,
            presence_tx,
            presence: Arc::new(RwLock::new(HashMap::new())),
            next_viewer: Arc::new(AtomicU64::new(1)),
        }
    }

    /// Validate, apply, and fan out an authoritative producer envelope.
    pub async fn publish(&self, envelope: TwinEnvelope) -> Result<(), crate::ApplyError> {
        if matches!(envelope.message, TwinMessage::Presence { .. }) {
            return Err(crate::ApplyError::ServerOnlyPresence);
        }
        let mut replica = self.replica.lock().await;
        replica.apply(envelope.clone())?;
        let graph = replica.graph().expect("successful apply has a graph");
        let rvf_json = String::from_utf8(graph.to_json().expect("snapshot serialization"))
            .expect("snapshot JSON is UTF-8");
        *self.snapshot.write().await = TwinEnvelope::new(
            envelope.stream_epoch.clone(),
            envelope.seq,
            TwinMessage::Snapshot {
                graph_schema_version: SCHEMA_VERSION,
                rvf_json,
            },
        );
        drop(replica);
        let _ = self.tx.send(envelope);
        Ok(())
    }
}

#[derive(Clone)]
struct AppState {
    hub: StreamHub,
    validator: Arc<dyn TokenValidator>,
    demo: Option<DemoBootstrap>,
}

/// Explicit development-only token issuer configuration. Production routers
/// omit this value and therefore do not expose a bootstrap endpoint.
#[derive(Clone)]
pub struct DemoBootstrap {
    key: EncodingKey,
    audience: String,
    ttl_seconds: u64,
}

impl DemoBootstrap {
    /// Create a demo issuer using the same signing material as the validator.
    /// TTL is capped at the production validator maximum.
    pub fn new(
        secret: &[u8],
        audience: impl Into<String>,
        ttl_seconds: u64,
    ) -> Result<Self, AuthError> {
        if secret.len() < 32 || ttl_seconds == 0 || ttl_seconds > MAX_TOKEN_TTL_SECONDS {
            return Err(AuthError::Invalid);
        }
        Ok(Self {
            key: EncodingKey::from_secret(secret),
            audience: audience.into(),
            ttl_seconds,
        })
    }
}

/// Build `/healthz`, `/v1/twin/ws`, and producer `/v1/twin/envelopes`.
pub fn router(hub: StreamHub, validator: Arc<dyn TokenValidator>) -> Router {
    router_with_demo(hub, validator, None)
}

/// Build the router with an explicit development bootstrap token issuer.
pub fn router_with_demo(
    hub: StreamHub,
    validator: Arc<dyn TokenValidator>,
    demo: Option<DemoBootstrap>,
) -> Router {
    Router::new()
        .route(
            "/healthz",
            get(|| async { Json(serde_json::json!({"status":"ok"})) }),
        )
        .route("/v1/twin/ws", get(websocket))
        .route("/v1/twin/envelopes", post(publish))
        .route("/demo/bootstrap", get(demo_bootstrap))
        .layer(DefaultBodyLimit::max(MAX_MESSAGE_BYTES))
        .with_state(AppState {
            hub,
            validator,
            demo,
        })
}

#[derive(Serialize)]
struct DemoTokenClaims<'a> {
    sub: &'a str,
    exp: u64,
    aud: &'a str,
    scope: &'a str,
}

#[derive(Serialize)]
struct DemoBootstrapResponse {
    token: String,
    expires_at: u64,
    websocket_url: &'static str,
    protocol_version: u16,
    graph_schema_version: u16,
}

async fn demo_bootstrap(
    State(state): State<AppState>,
) -> Result<Json<DemoBootstrapResponse>, StatusCode> {
    let demo = state.demo.as_ref().ok_or(StatusCode::NOT_FOUND)?;
    let issued = now();
    let expires_at = issued.saturating_add(demo.ttl_seconds);
    let claims = DemoTokenClaims {
        sub: "local-demo-viewer",
        exp: expires_at,
        aud: &demo.audience,
        scope: "twin:read twin:sensitive",
    };
    let token = jsonwebtoken::encode(&Header::new(Algorithm::HS256), &claims, &demo.key)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(DemoBootstrapResponse {
        token,
        expires_at,
        websocket_url: "/v1/twin/ws",
        protocol_version: PROTOCOL_VERSION,
        graph_schema_version: SCHEMA_VERSION,
    }))
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

async fn publish(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(envelope): Json<TwinEnvelope>,
) -> StatusCode {
    let claims = bearer(&headers).and_then(|t| state.validator.validate(t, now()).ok());
    if !claims.is_some_and(|c| c.has_scope("twin:write")) {
        return StatusCode::UNAUTHORIZED;
    }
    match state.hub.publish(envelope).await {
        Ok(()) => StatusCode::ACCEPTED,
        Err(_) => StatusCode::CONFLICT,
    }
}

async fn websocket(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let header_claims = bearer(&headers).and_then(|t| state.validator.validate(t, now()).ok());
    ws.max_message_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| serve_socket(socket, state, header_claims))
}

#[derive(Deserialize)]
struct ClientHello {
    #[serde(rename = "type")]
    kind: String,
    supported_protocol_versions: Vec<u16>,
    capabilities: Vec<String>,
    access_token: String,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientControl {
    RequestSnapshot { reason: String },
    AuthRefresh { access_token: String },
    PresenceUpdate { position: serde_json::Value },
    ClientHello {},
}
#[derive(Serialize)]
struct ServerHello<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    protocol_version: u16,
    capabilities: Vec<&'a str>,
    stream_epoch: String,
}

async fn serve_socket(mut socket: WebSocket, state: AppState, header_claims: Option<ViewerClaims>) {
    let first = match timeout(Duration::from_secs(5), socket.recv()).await {
        Ok(Some(Ok(Message::Text(t)))) if t.len() <= MAX_MESSAGE_BYTES => t,
        _ => return,
    };
    let hello: ClientHello = match serde_json::from_str(&first) {
        Ok(h) => h,
        Err(_) => return,
    };
    if hello.kind != "client_hello"
        || !hello
            .supported_protocol_versions
            .contains(&PROTOCOL_VERSION)
    {
        return;
    }
    let claims =
        match header_claims.or_else(|| state.validator.validate(&hello.access_token, now()).ok()) {
            Some(c) if c.has_scope("twin:read") => c,
            _ => return,
        };
    let supported = ["snapshot", "delta", "presence"];
    let caps: Vec<&str> = supported
        .into_iter()
        .filter(|c| hello.capabilities.iter().any(|v| v == c))
        .collect();
    let initial = state.hub.snapshot.read().await.clone();
    let stream_epoch = initial.stream_epoch.clone();
    let server_hello = ServerHello {
        kind: "server_hello",
        protocol_version: PROTOCOL_VERSION,
        capabilities: caps,
        stream_epoch: initial.stream_epoch.clone(),
    };
    if send_json(&mut socket, &server_hello).await.is_err() {
        return;
    }
    let mut token_expires_at = claims.expires_at;
    let mut projector = AccessProjector::new(DefaultAccessPolicy, claims);
    if send_projected(&mut socket, &mut projector, initial)
        .await
        .is_err()
    {
        return;
    }
    let mut rx = state.hub.tx.subscribe();
    let mut presence_rx = state.hub.presence_tx.subscribe();
    let viewer_id = state.hub.next_viewer.fetch_add(1, Ordering::Relaxed);
    let active: Vec<_> = state
        .hub
        .presence
        .read()
        .await
        .iter()
        .map(|(viewer_id, position)| PresenceUpdate {
            viewer_id: *viewer_id,
            position: *position,
            active: true,
        })
        .collect();
    if !active.is_empty() {
        let env = TwinEnvelope::new(stream_epoch, 0, TwinMessage::Presence { updates: active });
        if send_projected(&mut socket, &mut projector, env)
            .await
            .is_err()
        {
            return;
        }
    }
    let mut expiry_tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            _ = expiry_tick.tick() => if now() >= token_expires_at { break; },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) if text.len() <= MAX_MESSAGE_BYTES => {
                    match serde_json::from_str::<ClientControl>(&text) {
                        Ok(ClientControl::RequestSnapshot { reason }) => {
                            let _ = reason;
                            let snap = state.hub.snapshot.read().await.clone();
                            if send_projected(&mut socket, &mut projector, snap).await.is_err() { break; }
                        }
                        Ok(ClientControl::AuthRefresh { access_token }) => {
                            let Some(fresh) = state.validator.validate(&access_token, now()).ok().filter(|c| c.has_scope("twin:read")) else { break; };
                            token_expires_at = fresh.expires_at;
                            projector.replace_claims(fresh);
                            let snap = state.hub.snapshot.read().await.clone();
                            if send_projected(&mut socket, &mut projector, snap).await.is_err() { break; }
                        }
                        Ok(ClientControl::PresenceUpdate { position }) => {
                            let Ok(point) = serde_json::from_value::<EnuPoint>(position) else { break; };
                            if !valid_presence(&point) { break; }
                            state.hub.presence.write().await.insert(viewer_id, point);
                            let _ = state.hub.presence_tx.send(vec![PresenceUpdate { viewer_id, position: point, active: true }]);
                        }
                        _ => break,
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
            update = rx.recv() => match update {
                Ok(env) => if send_projected(&mut socket, &mut projector, env).await.is_err() { break; },
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    break; // reconnect reauthenticates and receives a fresh projection
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            update = presence_rx.recv() => if let Ok(updates) = update {
                let epoch = state.hub.snapshot.read().await.stream_epoch.clone();
                if send_projected(&mut socket, &mut projector, TwinEnvelope::new(epoch, 0, TwinMessage::Presence { updates })).await.is_err() { break; }
            },
        }
    }
    if let Some(position) = state.hub.presence.write().await.remove(&viewer_id) {
        let _ = state.hub.presence_tx.send(vec![PresenceUpdate {
            viewer_id,
            position,
            active: false,
        }]);
    }
}

fn valid_presence(p: &EnuPoint) -> bool {
    [p.east_m, p.north_m, p.up_m]
        .into_iter()
        .all(|v| v.is_finite() && v.abs() <= 100_000.0)
}

async fn send_json<T: Serialize>(socket: &mut WebSocket, value: &T) -> Result<(), ()> {
    socket
        .send(Message::Text(
            serde_json::to_string(value).map_err(|_| ())?.into(),
        ))
        .await
        .map_err(|_| ())
}
async fn send_projected(
    socket: &mut WebSocket,
    projector: &mut AccessProjector<DefaultAccessPolicy>,
    envelope: TwinEnvelope,
) -> Result<(), ()> {
    if let Some(env) = projector.project(envelope) {
        send_json(socket, &env).await?;
    }
    Ok(())
}

/// Serve until the listener fails.
pub async fn serve(
    addr: SocketAddr,
    hub: StreamHub,
    validator: Arc<dyn TokenValidator>,
) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router(hub, validator)).await
}

/// Serve with the explicitly enabled development bootstrap endpoint.
pub async fn serve_with_demo(
    addr: SocketAddr,
    hub: StreamHub,
    validator: Arc<dyn TokenValidator>,
    demo: DemoBootstrap,
) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router_with_demo(hub, validator, Some(demo))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use futures_util::{SinkExt, StreamExt};
    use wifi_densepose_geo::GeoRegistration;
    use wifi_densepose_worldgraph::{WorldGraph, WorldId, WorldNode};

    #[derive(Serialize)]
    struct SignedClaims<'a> {
        sub: &'a str,
        exp: u64,
        aud: &'a str,
        scope: &'a str,
    }

    struct FakeValidator;
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

    #[tokio::test]
    async fn publish_requires_write_scope_and_fans_out_valid_delta() {
        let graph = WorldGraph::new(GeoRegistration::default());
        let hub = StreamHub::new("e", graph.snapshot());
        let state = AppState {
            hub: hub.clone(),
            validator: Arc::new(FakeValidator),
            demo: None,
        };
        let envelope = TwinEnvelope::new("e", 1, TwinMessage::RemoveNode { id: WorldId(99) });
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer reader"));
        assert_eq!(
            publish(State(state.clone()), headers, Json(envelope.clone())).await,
            StatusCode::UNAUTHORIZED
        );
        let mut rx = hub.tx.subscribe();
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer writer"));
        assert_eq!(
            publish(State(state), headers, Json(envelope)).await,
            StatusCode::ACCEPTED
        );
        assert_eq!(rx.recv().await.unwrap().seq, 1);

        let injected = TwinEnvelope::new(
            "e",
            2,
            TwinMessage::Presence {
                updates: vec![PresenceUpdate {
                    viewer_id: 777,
                    position: EnuPoint {
                        east_m: 0.0,
                        north_m: 0.0,
                        up_m: 0.0,
                    },
                    active: true,
                }],
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer writer"));
        let state = AppState {
            hub,
            validator: Arc::new(FakeValidator),
            demo: None,
        };
        assert_eq!(
            publish(State(state), headers, Json(injected)).await,
            StatusCode::CONFLICT
        );
    }

    #[test]
    fn rejects_presence_outside_finite_installation_bounds() {
        assert!(valid_presence(&EnuPoint {
            east_m: 1.0,
            north_m: -2.0,
            up_m: 3.0
        }));
        assert!(!valid_presence(&EnuPoint {
            east_m: f64::NAN,
            north_m: 0.0,
            up_m: 0.0
        }));
        assert!(!valid_presence(&EnuPoint {
            east_m: 100_001.0,
            north_m: 0.0,
            up_m: 0.0
        }));
    }

    #[test]
    fn jwt_is_audience_bound_and_short_lived() {
        let secret = b"01234567890123456789012345678901";
        let validator = JwtTokenValidator::new(secret, "worldgraph-stream").unwrap();
        let now = now();
        let sign = |aud, exp| {
            jsonwebtoken::encode(
                &jsonwebtoken::Header::new(Algorithm::HS256),
                &SignedClaims {
                    sub: "alice",
                    exp,
                    aud,
                    scope: "twin:read",
                },
                &jsonwebtoken::EncodingKey::from_secret(secret),
            )
            .unwrap()
        };
        assert!(validator
            .validate(&sign("worldgraph-stream", now + 60), now)
            .is_ok());
        assert!(validator.validate(&sign("other", now + 60), now).is_err());
        assert!(validator
            .validate(&sign("worldgraph-stream", now + 301), now)
            .is_err());
    }

    #[tokio::test]
    async fn presence_channel_fans_out_pseudonymous_updates_without_graph_persistence() {
        let graph = WorldGraph::new(GeoRegistration::default());
        let hub = StreamHub::new("e", graph.snapshot());
        let before = hub.snapshot.read().await.clone();
        let mut a = hub.presence_tx.subscribe();
        let mut b = hub.presence_tx.subscribe();
        let update = PresenceUpdate {
            viewer_id: hub.next_viewer.fetch_add(1, Ordering::Relaxed),
            position: EnuPoint {
                east_m: 1.0,
                north_m: 2.0,
                up_m: 0.0,
            },
            active: true,
        };
        hub.presence_tx.send(vec![update.clone()]).unwrap();
        assert_eq!(a.recv().await.unwrap()[0].viewer_id, update.viewer_id);
        assert_eq!(b.recv().await.unwrap()[0].viewer_id, update.viewer_id);
        assert_eq!(hub.snapshot.read().await.seq, before.seq);
    }

    #[tokio::test]
    async fn websocket_client_hello_precedes_projected_state() {
        let graph = WorldGraph::new(GeoRegistration::default());
        let hub = StreamHub::new("epoch-ws", graph.snapshot());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router(hub, Arc::new(FakeValidator)))
                .await
                .unwrap();
        });

        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/v1/twin/ws"))
            .await
            .unwrap();
        ws.send(tokio_tungstenite::tungstenite::Message::Text(
            serde_json::json!({
                "type": "client_hello", "supported_protocol_versions": [1],
                "capabilities": ["snapshot", "delta", "presence"], "access_token": "reader"
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
        let hello = ws.next().await.unwrap().unwrap().into_text().unwrap();
        let hello: serde_json::Value = serde_json::from_str(&hello).unwrap();
        assert_eq!(hello["type"], "server_hello");
        assert_eq!(hello["stream_epoch"], "epoch-ws");
        let envelope = ws.next().await.unwrap().unwrap().into_text().unwrap();
        let envelope: serde_json::Value = serde_json::from_str(&envelope).unwrap();
        assert_eq!(envelope["message"]["op"], "snapshot");

        let (mut malformed, _) =
            tokio_tungstenite::connect_async(format!("ws://{addr}/v1/twin/ws"))
                .await
                .unwrap();
        malformed
            .send(tokio_tungstenite::tungstenite::Message::Text("{}".into()))
            .await
            .unwrap();
        let response = timeout(Duration::from_millis(500), malformed.next()).await;
        assert!(!matches!(
            response,
            Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(_))))
        ));
        task.abort();
    }

    #[tokio::test]
    async fn demo_bootstrap_token_connects_and_receives_changing_state() {
        let secret = b"01234567890123456789012345678901";
        let audience = "worldgraph-stream";
        let mut graph = WorldGraph::new(GeoRegistration::default());
        graph.upsert_node(WorldNode::Room {
            id: WorldId(1),
            area_id: None,
            name: "Demo".into(),
            bounds_enu: wifi_densepose_worldgraph::ZoneBoundsEnu::Rectangle {
                min_e: 0.0,
                min_n: 0.0,
                max_e: 4.0,
                max_n: 4.0,
            },
            floor: 0,
        });
        let hub = StreamHub::new("demo-e2e", graph.snapshot());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = router_with_demo(
            hub.clone(),
            Arc::new(JwtTokenValidator::new(secret, audience).unwrap()),
            Some(DemoBootstrap::new(secret, audience, 60).unwrap()),
        );
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let bootstrap: serde_json::Value = reqwest::get(format!("http://{addr}/demo/bootstrap"))
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(bootstrap["websocket_url"], "/v1/twin/ws");
        let token = bootstrap["token"].as_str().unwrap();
        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/v1/twin/ws"))
            .await
            .unwrap();
        ws.send(tokio_tungstenite::tungstenite::Message::Text(
            serde_json::json!({
                "type":"client_hello", "supported_protocol_versions":[1],
                "capabilities":["snapshot","delta"], "access_token":token
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
        let _hello = ws.next().await.unwrap().unwrap();
        let snapshot = ws.next().await.unwrap().unwrap().into_text().unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&snapshot).unwrap()["message"]["op"],
            "snapshot"
        );

        hub.publish(TwinEnvelope::new(
            "demo-e2e",
            1,
            TwinMessage::UpsertNode {
                node: WorldNode::Room {
                    id: WorldId(1),
                    area_id: None,
                    name: "Demo changed".into(),
                    bounds_enu: wifi_densepose_worldgraph::ZoneBoundsEnu::Rectangle {
                        min_e: 0.0,
                        min_n: 0.0,
                        max_e: 4.0,
                        max_n: 4.0,
                    },
                    floor: 0,
                },
            },
        ))
        .await
        .unwrap();
        let delta = timeout(Duration::from_secs(1), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .into_text()
            .unwrap();
        let delta: serde_json::Value = serde_json::from_str(&delta).unwrap();
        assert_eq!(delta["message"]["op"], "upsert_node");
        assert_eq!(delta["message"]["node"]["name"], "Demo changed");
        task.abort();
    }

    #[tokio::test]
    async fn production_router_does_not_expose_demo_token_minting() {
        let hub = StreamHub::new(
            "prod",
            WorldGraph::new(GeoRegistration::default()).snapshot(),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router(hub, Arc::new(FakeValidator)))
                .await
                .unwrap()
        });
        assert_eq!(
            reqwest::get(format!("http://{addr}/demo/bootstrap"))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        task.abort();
    }
}
