//! End-to-end client flow: plan → provider → verified bundle → graph record.
//!
//! The flow is written against the [`GenerativeWorldModel`] trait, so the same
//! code runs against the real PAN 2 worker, a worker with a test renderer, or
//! any other ADR-204 provider.

use std::path::{Path, PathBuf};
use std::time::Duration;

use wifi_densepose_worldgraph::{WorldGraph, WorldId};
use wifi_densepose_worldmodel::{
    CancellationToken, DeploymentPolicy, ExternalModelConfig, ExternalModelKind,
    ExternalSidecarProvider, GenerativeWorldModel, SidecarConfig, SimulatedFrameEnvelope,
};

use crate::bundle::{write_bundle, BundleRequest, RolloutManifest};
use crate::compile::{compile, CompiledPrompt};
use crate::plan::RolloutPlan;
use crate::projection::record_rollout;
use crate::Pan2Error;

/// Where the PAN 2 worker runs relative to the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerPlacement {
    /// Same trust boundary as the caller; the weights are at this local path.
    Local {
        /// Native-layout transformer checkpoint directory.
        weights_path: PathBuf,
    },
    /// A rented or remote GPU host. Every plan must carry
    /// `hosted_processing_approved: true` or the provider refuses it.
    Hosted,
}

/// Builds the ADR-204 sidecar provider for a PAN 2 worker.
///
/// `socket_path` is the worker's control socket, or a local forward of it
/// (for example `ssh -L local.sock:remote.sock`). `timeout` bounds one whole
/// generation, model load included.
pub fn pan2_provider(
    socket_path: impl Into<PathBuf>,
    timeout: Duration,
    placement: WorkerPlacement,
    terms_accepted: bool,
) -> Result<ExternalSidecarProvider, Pan2Error> {
    let (hosted, weights_path) = match placement {
        WorkerPlacement::Local { weights_path } => (false, Some(weights_path)),
        WorkerPlacement::Hosted => (true, None),
    };
    let config = ExternalModelConfig {
        kind: ExternalModelKind::Pan2,
        terms_accepted,
        credential_env: None,
        weights_path,
    };
    Ok(config.build_sidecar(SidecarConfig {
        socket_path: socket_path.into(),
        timeout,
        deployment: DeploymentPolicy::production(),
        cancellation: CancellationToken::default(),
        hosted,
    })?)
}

/// What one provider step returned, before any media has been verified.
#[derive(Debug, Clone)]
pub struct Generated {
    /// The caption the client compiled; the worker compiles the same one.
    pub prompt: CompiledPrompt,
    /// Envelope describing the generated files.
    pub envelope: SimulatedFrameEnvelope,
}

/// Runs one plan as a fresh single-step session.
pub async fn generate(
    provider: &dyn GenerativeWorldModel,
    plan: &RolloutPlan,
) -> Result<Generated, Pan2Error> {
    let (seed, action) = plan.into_inputs(0, 0)?;
    // Compile locally first: an invalid plan never reaches the GPU host.
    let prompt = compile(&seed, &action)?;
    let mut session = provider.initialize(seed).await?;
    let step = provider.step(&mut session, action).await;
    let envelope = match step {
        Ok(chunk) => chunk.into_envelope(&session, 0),
        Err(error) => {
            let _ = provider.finish(session).await;
            return Err(error.into());
        }
    };
    provider.finish(session).await?;
    Ok(Generated { prompt, envelope })
}

/// A verified rollout and the graph node that records it.
#[derive(Debug, Clone)]
pub struct Recorded {
    /// The bundle manifest written to disk.
    pub manifest: RolloutManifest,
    /// Id of the zero-confidence `SemanticState` added to the graph.
    pub state_id: WorldId,
}

/// Verifies the generated files in the local media copy, writes the RuLab
/// bundle, and records the rollout in `graph`.
///
/// The graph is only touched after every file has matched its descriptor.
#[allow(clippy::too_many_arguments)]
pub fn accept(
    generated: &Generated,
    plan: &RolloutPlan,
    media_root: &Path,
    out_dir: &Path,
    first_frame: Option<&Path>,
    graph: &mut WorldGraph,
    sources: &[WorldId],
    now_unix_ms: i64,
) -> Result<Recorded, Pan2Error> {
    let image = match (&plan.image, first_frame) {
        (Some(image), Some(path)) => Some((path, image.sha256.as_str())),
        (None, None) => None,
        _ => {
            return Err(Pan2Error::invalid(
                "the plan's image and the local first frame must be given together",
            ))
        }
    };
    // The worker must have rendered the caption this client compiled.
    let worker_caption = generated
        .envelope
        .chunk
        .frames
        .iter()
        .find(|frame| frame.locator.ends_with("/caption.json"))
        .map(|frame| frame.content_hash.as_str());
    if worker_caption != Some(format!("sha256:{}", generated.prompt.prompt_sha256).as_str()) {
        return Err(Pan2Error::Contract(
            "the worker rendered a different caption than the client compiled".into(),
        ));
    }
    let manifest = write_bundle(&BundleRequest {
        name: &plan.name,
        envelope: &generated.envelope,
        media_root,
        out_dir,
        duration_sec: generated.prompt.duration_sec(),
        width: 1248,
        height: 704,
        first_frame: image,
    })?;
    let state_id = record_rollout(graph, &generated.envelope, sources, now_unix_ms)?;
    Ok(Recorded { manifest, state_id })
}
