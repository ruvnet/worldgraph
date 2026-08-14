//! Error types for the OccWorld world-model bridge (ADR-147).

use thiserror::Error;

/// All errors that can be returned by the OccWorld bridge.
#[derive(Debug, Error)]
pub enum WorldModelError {
    /// Could not connect to the Unix-domain socket served by the Python
    /// OccWorld inference process.
    #[error("could not connect to OccWorld socket at `{path}`: {source}")]
    SocketConnect {
        /// The socket path that was attempted.
        path: String,
        /// The underlying I/O error.
        source: std::io::Error,
    },

    /// A provider operation exceeded its configured wall-clock deadline.
    #[error("world-model operation timed out after {timeout_s}s")]
    Timeout {
        /// The configured timeout in seconds.
        timeout_s: u64,
    },

    /// The JSON payload received from the server could not be decoded, or the
    /// payload we tried to send could not be encoded.
    #[error("JSON (de)serialisation error: {0}")]
    SerdeJson(#[from] serde_json::Error),

    /// The server sent a response that violates the newline-delimited JSON
    /// protocol (e.g. an unexpected EOF before the newline delimiter, or an
    /// oversized frame that exceeded the read buffer limit).
    #[error("protocol error: {0}")]
    Protocol(String),

    /// The OccWorld inference server reported that GPU VRAM is unavailable
    /// (out-of-memory condition on the device side).
    #[error("OccWorld server reports VRAM unavailable: {0}")]
    VramUnavailable(String),

    /// A generative-model input exceeded a limit or violated the typed contract.
    #[error("invalid generative world-model input: {0}")]
    InvalidInput(String),

    /// The action belongs to a different session epoch.
    #[error("action epoch {actual} does not match session epoch {expected}")]
    EpochMismatch {
        /// Epoch currently owned by the session.
        expected: u64,
        /// Epoch supplied by the action.
        actual: u64,
    },

    /// The action has already been accepted by this session.
    #[error("duplicate action sequence {actual}; next sequence is {expected}")]
    DuplicateSequence {
        /// Next sequence expected by the session.
        expected: u64,
        /// Sequence supplied by the action.
        actual: u64,
    },

    /// One or more actions are missing before the supplied action.
    #[error("action sequence gap: expected {expected}, got {actual}")]
    SequenceGap {
        /// Next sequence expected by the session.
        expected: u64,
        /// Sequence supplied by the action.
        actual: u64,
    },

    /// The configured deployment is not allowed to load the provider license.
    #[error("provider license `{license}` is not allowed: {reason}")]
    LicenseDenied {
        /// Machine-readable SPDX expression or provider license identifier.
        license: String,
        /// Policy decision detail.
        reason: String,
    },

    /// A stateful generative-model operation was cancelled.
    #[error("generative world-model operation cancelled")]
    Cancelled,

    /// A stateful external provider failed or returned an invalid result.
    #[error("generative world-model provider error: {0}")]
    Provider(String),
}
