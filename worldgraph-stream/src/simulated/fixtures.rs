//! Shared test fixtures for the simulated channel.

use wifi_densepose_worldmodel::{
    FrameDescriptor, LicensePolicy, ModelProvenance, PrivacyDecision, RetentionPolicy,
    SimulatedFrameChunk, SimulatedFrameEnvelope,
};

/// A valid single-frame envelope at the given session position.
pub(super) fn envelope(session_id: &str, epoch: u64, sequence: u64) -> SimulatedFrameEnvelope {
    SimulatedFrameEnvelope {
        schema_version: 1,
        session_id: session_id.into(),
        epoch,
        sequence,
        chunk: SimulatedFrameChunk {
            frames: vec![FrameDescriptor {
                transport: "https".into(),
                locator: format!("https://media.example/{session_id}/{epoch}/{sequence}"),
                content_hash: "sha256:frame".into(),
                byte_length: 1_024,
                media_type: "video/av1".into(),
            }],
            provenance: ModelProvenance {
                provider: "pan2".into(),
                model: "pan-2".into(),
                checkpoint: "sha256:checkpoint".into(),
                runtime_version: "0.0.0-test".into(),
                source_snapshot_hash: "sha256:snapshot".into(),
                source_stream_epoch: epoch,
                prompt_action_hash: "sha256:action".into(),
                generation_seed: 7,
                generation_sequence: sequence,
                simulated: true,
                confidence: 0.5,
                privacy: PrivacyDecision {
                    projection_id: "projection-test".into(),
                    hosted_processing_approved: false,
                    redactions_applied: 0,
                    retention: RetentionPolicy::Ephemeral,
                },
                license: LicensePolicy::apache_2_0(),
            },
        },
    }
}
