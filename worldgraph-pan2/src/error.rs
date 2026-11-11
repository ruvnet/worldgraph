//! Error type for the PAN 2 provider.

use thiserror::Error;

/// Everything that can go wrong between a worldgraph scene and a verified rollout.
#[derive(Debug, Error)]
pub enum Pan2Error {
    /// The scene, plan or action cannot be expressed as a PAN 2 caption.
    #[error("invalid PAN 2 input: {0}")]
    InvalidInput(String),

    /// The compiled caption is larger than the structural byte budget.
    ///
    /// The budget is a conservative stand-in for the text encoder's token
    /// limit. It is not a measured token count.
    #[error("caption is {bytes} bytes; the structural budget is {budget} bytes")]
    CaptionTooLong {
        /// Serialized caption size.
        bytes: usize,
        /// Budget that was exceeded.
        budget: usize,
    },

    /// The upstream generator failed, timed out, or produced no video.
    #[error("PAN 2 renderer failed: {0}")]
    Renderer(String),

    /// A media file does not match its descriptor.
    #[error("media verification failed for `{file}`: {reason}")]
    MediaMismatch {
        /// File that failed verification.
        file: String,
        /// What differed.
        reason: String,
    },

    /// A rollout bundle or Spaces payload violates its contract.
    #[error("contract violation: {0}")]
    Contract(String),

    /// Filesystem or socket failure.
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    /// JSON encode/decode failure.
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// The session contract in `wifi-densepose-worldmodel` rejected the call.
    #[error(transparent)]
    WorldModel(#[from] wifi_densepose_worldmodel::WorldModelError),
}

impl Pan2Error {
    /// Shorthand for [`Pan2Error::InvalidInput`].
    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::InvalidInput(message.into())
    }
}
