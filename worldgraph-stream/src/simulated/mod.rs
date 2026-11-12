//! HTTP API for simulated world-model output, separate from the twin stream.
//!
//! ADR-204 section 1 keeps authority and simulation apart: sensed graph state
//! travels as `TwinEnvelope`s, generated frames travel as
//! [`SimulatedFrameEnvelope`]s and are never encoded as graph deltas. This
//! module is the simulated side. Its router state holds a [`SimulatedStore`]
//! and a token validator and nothing else, so no handler here can reach the
//! twin [`StreamHub`](crate::server::StreamHub) or its subscribers.
//!
//! | Route | Scope | Purpose |
//! |---|---|---|
//! | `POST /v1/sim/envelopes` | `twin:write` | Publish one envelope |
//! | `GET /v1/sim/envelopes?session_id=&after_sequence=&limit=` | `twin:read` | List one session, oldest first (optional `after_epoch`, see [`ListCursor`]) |
//! | `GET /v1/sim/sessions` | `twin:read` | List known sessions |
//!
//! Only envelopes (frame descriptors and provenance) cross these routes.
//! Media bytes are neither accepted nor served. Errors are JSON
//! `{"error": "..."}` bodies.

mod store;
mod validate;

#[cfg(test)]
mod fixtures;
#[cfg(test)]
mod separation_tests;
#[cfg(test)]
mod tests;

use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{
        rejection::{BytesRejection, QueryRejection},
        DefaultBodyLimit, Query, State,
    },
    http::{header::CONTENT_TYPE, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use wifi_densepose_worldmodel::SimulatedFrameEnvelope;

use crate::server::{authorize, TokenValidator};

pub use store::{ListCursor, PublishReceipt, SessionSummary, SimulatedStore};
pub use validate::{validate_envelope, validate_session_id};
pub use wifi_densepose_worldmodel::runtime::MAX_SIDECAR_CONTROL_BYTES as MAX_SIMULATED_ENVELOPE_BYTES;

/// The only `schema_version` accepted on the simulated channel.
pub const SIMULATED_SCHEMA_VERSION: u32 = 1;
/// Maximum `session_id` length in UTF-8 bytes.
pub const MAX_SESSION_ID_BYTES: usize = 128;
/// Maximum number of sessions retained by a [`SimulatedStore`].
pub const MAX_SESSIONS: usize = 64;
/// Maximum number of envelopes retained per session.
pub const MAX_ENVELOPES_PER_SESSION: usize = 256;
/// Envelopes returned by a list request that names no `limit`.
pub const DEFAULT_LIST_LIMIT: usize = 50;
/// Largest honoured list `limit`; larger requests are clamped to it.
pub const MAX_LIST_LIMIT: usize = 100;

/// Scope required to publish, shared with the twin producer route.
const PUBLISH_SCOPE: &str = "twin:write";
/// Scope required to read, shared with the twin websocket.
const READ_SCOPE: &str = "twin:read";

/// Why a simulated envelope was not accepted.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SimulatedError {
    /// The envelope violates a field-level rule; the message names it.
    #[error("{0}")]
    Invalid(String),
    /// The envelope duplicates or precedes the session's newest position.
    #[error(
        "session {session_id}: epoch {epoch} sequence {sequence} is not after \
         epoch {latest_epoch} sequence {latest_sequence}"
    )]
    OutOfOrder {
        /// Session that rejected the envelope.
        session_id: String,
        /// Epoch of the rejected envelope.
        epoch: u64,
        /// Sequence of the rejected envelope.
        sequence: u64,
        /// Epoch of the newest accepted envelope.
        latest_epoch: u64,
        /// Sequence of the newest accepted envelope.
        latest_sequence: u64,
    },
}

#[derive(Clone)]
struct SimState {
    store: SimulatedStore,
    validator: Arc<dyn TokenValidator>,
}

/// Build the `/v1/sim/*` routes over `store`.
///
/// The returned router carries its own request-body limit of
/// [`MAX_SIMULATED_ENVELOPE_BYTES`] and can be merged into any other router.
/// [`crate::server::router`] already does so.
pub fn routes(store: SimulatedStore, validator: Arc<dyn TokenValidator>) -> Router {
    Router::new()
        .route("/v1/sim/envelopes", post(publish).get(list))
        .route("/v1/sim/sessions", get(sessions))
        .layer(DefaultBodyLimit::max(MAX_SIMULATED_ENVELOPE_BYTES))
        .with_state(SimState { store, validator })
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(serde_json::json!({ "error": message.into() }))).into_response()
}

/// `Some(response)` when the request lacks a valid token carrying `scope`.
fn deny(state: &SimState, headers: &HeaderMap, scope: &str) -> Option<Response> {
    authorize(headers, state.validator.as_ref(), scope)
        .is_none()
        .then(|| {
            error(
                StatusCode::UNAUTHORIZED,
                format!("a valid bearer token with scope {scope} is required"),
            )
        })
}

fn is_json(headers: &HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
}

async fn publish(
    State(state): State<SimState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    if let Some(response) = deny(&state, &headers, PUBLISH_SCOPE) {
        return response;
    }
    let body = match body {
        Ok(body) if body.len() <= MAX_SIMULATED_ENVELOPE_BYTES => body,
        Ok(_) => return too_large(),
        Err(rejection) if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE => {
            return too_large()
        }
        Err(_) => return error(StatusCode::BAD_REQUEST, "request body could not be read"),
    };
    if !is_json(&headers) {
        return error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "content-type must be application/json",
        );
    }
    let envelope: SimulatedFrameEnvelope = match serde_json::from_slice(&body) {
        Ok(envelope) => envelope,
        Err(err) if err.is_data() => {
            return error(
                StatusCode::UNPROCESSABLE_ENTITY,
                format!("body is not a SimulatedFrameEnvelope: {err}"),
            )
        }
        Err(err) => return error(StatusCode::BAD_REQUEST, format!("malformed JSON: {err}")),
    };
    match state.store.publish(envelope) {
        Ok(receipt) => (
            StatusCode::ACCEPTED,
            Json(serde_json::json!({
                "accepted": true,
                "session_id": receipt.session_id,
                "epoch": receipt.epoch,
                "sequence": receipt.sequence,
            })),
        )
            .into_response(),
        Err(err @ SimulatedError::Invalid(_)) => {
            error(StatusCode::UNPROCESSABLE_ENTITY, err.to_string())
        }
        Err(err @ SimulatedError::OutOfOrder { .. }) => {
            error(StatusCode::CONFLICT, err.to_string())
        }
    }
}

fn too_large() -> Response {
    error(
        StatusCode::PAYLOAD_TOO_LARGE,
        format!("body exceeds {MAX_SIMULATED_ENVELOPE_BYTES} bytes"),
    )
}

#[derive(Deserialize)]
struct ListParams {
    session_id: Option<String>,
    after_epoch: Option<u64>,
    after_sequence: Option<u64>,
    limit: Option<usize>,
}

async fn list(
    State(state): State<SimState>,
    headers: HeaderMap,
    params: Result<Query<ListParams>, QueryRejection>,
) -> Response {
    if let Some(response) = deny(&state, &headers, READ_SCOPE) {
        return response;
    }
    let params = match params {
        Ok(Query(params)) => params,
        Err(rejection) => {
            return error(
                StatusCode::BAD_REQUEST,
                format!("invalid query: {}", rejection.body_text()),
            )
        }
    };
    let Some(session_id) = params.session_id else {
        return error(StatusCode::BAD_REQUEST, "session_id is required");
    };
    if let Err(err) = validate_session_id(&session_id) {
        return error(StatusCode::BAD_REQUEST, err.to_string());
    }
    let cursor = ListCursor {
        after_epoch: params.after_epoch,
        after_sequence: params.after_sequence,
    };
    let limit = params
        .limit
        .unwrap_or(DEFAULT_LIST_LIMIT)
        .min(MAX_LIST_LIMIT);
    let envelopes = state.store.list(&session_id, cursor, limit);
    Json(serde_json::json!({
        "session_id": session_id,
        "count": envelopes.len(),
        "envelopes": envelopes,
    }))
    .into_response()
}

async fn sessions(State(state): State<SimState>, headers: HeaderMap) -> Response {
    if let Some(response) = deny(&state, &headers, READ_SCOPE) {
        return response;
    }
    Json(serde_json::json!({ "sessions": state.store.sessions() })).into_response()
}
