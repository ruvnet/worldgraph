//! Replay-safe and authorization-safe realtime WorldGraph protocol.

#![forbid(unsafe_code)]

mod access;
mod protocol;

#[cfg(feature = "server")]
pub mod server;

pub use access::{AccessProjector, DefaultAccessPolicy, TwinAccessPolicy, ViewerClaims};
pub use protocol::{
    ApplyError, ApplyOutcome, PresenceUpdate, TwinEnvelope, TwinMessage, TwinReplica,
    PROTOCOL_VERSION,
};
