//! WorldGraph error type.

use crate::model::WorldId;

/// Errors from WorldGraph operations.
#[derive(Debug, thiserror::Error)]
pub enum WorldGraphError {
    /// An edge endpoint referenced an unknown node.
    #[error("unknown node {0:?}")]
    UnknownNode(WorldId),

    /// A persisted payload uses a newer schema than this build understands.
    #[error("unsupported world graph schema version {found} (maximum {maximum})")]
    UnsupportedSchema {
        /// Version found in the payload.
        found: u16,
        /// Newest version understood by this build.
        maximum: u16,
    },

    /// (De)serialisation of the persisted graph failed.
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
}
