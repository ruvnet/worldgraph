//! The only way a rollout touches the authoritative graph.
//!
//! ADR-204 §1: generated frames never mutate the graph. A rollout may be
//! *recorded* as one `SemanticState` whose statement says it is a simulation,
//! whose confidence is zero, and whose provenance names the model, checkpoint,
//! prompt hash, seed, source snapshot and privacy decision. No room, person,
//! object or event node is created or changed.

use wifi_densepose_worldgraph::{SemanticProvenance, WorldGraph, WorldId};
use wifi_densepose_worldmodel::{RetentionPolicy, SimulatedFrameEnvelope};

use crate::Pan2Error;

/// Calibration marker stored with every rollout record.
pub const UNCALIBRATED: &str = "uncalibrated:simulated-rollout";

/// Records a rollout as a zero-confidence `SemanticState` and returns its id.
///
/// `sources` are existing nodes the scene projection was built from; a
/// `derived_from` edge is added to each one that exists.
pub fn record_rollout(
    graph: &mut WorldGraph,
    envelope: &SimulatedFrameEnvelope,
    sources: &[WorldId],
    valid_from_unix_ms: i64,
) -> Result<WorldId, Pan2Error> {
    let provenance = &envelope.chunk.provenance;
    if !provenance.simulated {
        return Err(Pan2Error::Contract(
            "only simulated output can be recorded as a rollout".into(),
        ));
    }
    let clip = envelope
        .chunk
        .frames
        .iter()
        .find(|frame| frame.media_type == "video/mp4")
        .ok_or_else(|| Pan2Error::Contract("envelope has no video descriptor".into()))?;

    let statement = format!(
        "SIMULATED rollout (model prediction, not an observation): {} {} session {} epoch {} step {}, clip {}",
        provenance.provider,
        provenance.model,
        envelope.session_id,
        envelope.epoch,
        envelope.sequence,
        clip.content_hash,
    );
    let retention = match provenance.privacy.retention {
        RetentionPolicy::Ephemeral => "ephemeral",
        RetentionPolicy::PolicyBound => "policy_bound",
    };
    let evidence = vec![
        clip.content_hash.clone(),
        format!("prompt:{}", provenance.prompt_action_hash),
        format!("snapshot:{}", provenance.source_snapshot_hash),
    ];
    let record = SemanticProvenance {
        evidence,
        model_version: format!(
            "{}/{}@{} runtime {} seed {} sequence {} license {}",
            provenance.provider,
            provenance.model,
            provenance.checkpoint,
            provenance.runtime_version,
            provenance.generation_seed,
            provenance.generation_sequence,
            provenance.license.license_id,
        ),
        calibration_version: UNCALIBRATED.into(),
        privacy_decision: format!(
            "{}/hosted_processing_approved={}/redactions={}/retention={}",
            provenance.privacy.projection_id,
            provenance.privacy.hosted_processing_approved,
            provenance.privacy.redactions_applied,
            retention,
        ),
    };
    Ok(graph.add_semantic_state(statement, 0.0, valid_from_unix_ms, record, sources))
}
