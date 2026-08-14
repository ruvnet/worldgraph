//! Provider-neutral, stateful generative world-model runtime (ADR-204).
//!
//! The types in this module deliberately accept only an authorized spatial
//! projection. Raw RF evidence, embeddings, audit records, and graph nodes are
//! not representable in [`SceneSeed`] or [`ActionChunk`]. Generated media is
//! returned separately from the authoritative world graph.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[cfg(unix)]
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::UnixStream;

use crate::WorldModelError;

/// Maximum number of authorized scene primitives accepted per initialization.
pub const MAX_SCENE_PRIMITIVES: usize = 16_384;
/// Maximum action samples accepted in one step.
pub const MAX_ACTION_SAMPLES: usize = 256;
/// Maximum time span covered by a single action chunk.
pub const MAX_ACTION_DURATION_MS: u32 = 60_000;
/// Maximum number of provider metadata entries.
pub const MAX_METADATA_ENTRIES: usize = 32;
/// Maximum metadata key length in UTF-8 bytes.
pub const MAX_METADATA_KEY_BYTES: usize = 64;
/// Maximum metadata value length in UTF-8 bytes.
pub const MAX_METADATA_VALUE_BYTES: usize = 512;
/// Maximum newline-delimited sidecar control response.
pub const MAX_SIDECAR_CONTROL_BYTES: usize = 256 * 1024;
/// Maximum number of media descriptors accepted for a single action.
pub const MAX_FRAME_DESCRIPTORS: usize = 1_024;
/// Maximum aggregate encoded media size advertised for a single action.
pub const MAX_FRAME_BYTES_PER_CHUNK: u64 = 512 * 1024 * 1024;

/// Boxed future used to keep [`GenerativeWorldModel`] object-safe without an
/// async-trait dependency.
pub type ModelFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, WorldModelError>> + Send + 'a>>;

/// Permitted use category declared by a provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LicenseUsage {
    /// Provider may be selected in commercial/production environments.
    Production,
    /// Provider is restricted to explicitly enabled non-commercial research.
    ResearchOnly,
}

/// Machine-readable provider licensing policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LicensePolicy {
    /// SPDX expression when available, otherwise a stable license identifier.
    pub license_id: String,
    /// Highest permitted deployment use.
    pub usage: LicenseUsage,
    /// Whether redistribution of provider code or weights is allowed.
    pub redistribution_allowed: bool,
    /// Whether downstream artifacts must retain attribution/notice material.
    pub attribution_required: bool,
    /// Optional short operational note; not a substitute for legal review.
    pub notice: Option<String>,
}

impl LicensePolicy {
    /// Apache-2.0 production policy used by compatible providers and the mock.
    pub fn apache_2_0() -> Self {
        Self {
            license_id: "Apache-2.0".into(),
            usage: LicenseUsage::Production,
            redistribution_allowed: true,
            attribution_required: true,
            notice: None,
        }
    }

    fn enforce(&self, deployment: &DeploymentPolicy) -> Result<(), WorldModelError> {
        if self.usage == LicenseUsage::ResearchOnly
            && (deployment.environment != DeploymentEnvironment::NonCommercialResearch
                || !deployment.allow_research_only)
        {
            return Err(WorldModelError::LicenseDenied {
                license: self.license_id.clone(),
                reason: "research-only providers require both a non-commercial research environment and explicit opt-in".into(),
            });
        }
        Ok(())
    }
}

/// Deployment category used for provider admission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeploymentEnvironment {
    /// Commercial, customer-facing, or otherwise production use.
    Production,
    /// Non-commercial research/evaluation environment.
    NonCommercialResearch,
}

/// Local policy applied before a provider receives any input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeploymentPolicy {
    /// Declared deployment environment.
    pub environment: DeploymentEnvironment,
    /// Explicit opt-in required in addition to a research environment.
    pub allow_research_only: bool,
}

impl DeploymentPolicy {
    /// Conservative production policy.
    pub fn production() -> Self {
        Self {
            environment: DeploymentEnvironment::Production,
            allow_research_only: false,
        }
    }
}

/// Media retention class chosen by the privacy projection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetentionPolicy {
    /// Do not persist generated media beyond delivery.
    Ephemeral,
    /// Persist only according to an external bounded retention policy.
    PolicyBound,
}

/// Auditable privacy decision made before provider invocation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrivacyDecision {
    /// Stable identifier for the authorized projection/scope, not a user ID.
    pub projection_id: String,
    /// Whether sending the projection to a hosted processor was approved.
    pub hosted_processing_approved: bool,
    /// Number of fields/nodes removed before constructing this input.
    pub redactions_applied: u32,
    /// Required media retention behavior.
    pub retention: RetentionPolicy,
}

/// Sanitized scene geometry that can cross the model boundary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScenePrimitive {
    /// Anonymous point in local scene coordinates.
    Point {
        /// East/x coordinate in metres.
        x_m: f32,
        /// North/y coordinate in metres.
        y_m: f32,
        /// Up/z coordinate in metres.
        z_m: f32,
        /// Coarse anonymous semantic class.
        class: String,
    },
    /// Anonymous axis-aligned extent in local scene coordinates.
    Box {
        /// Local-space centre coordinates in metres.
        center_m: [f32; 3],
        /// Positive width/height/depth in metres.
        size_m: [f32; 3],
        /// Coarse anonymous semantic class.
        class: String,
    },
}

/// Authorized, bounded initialization input for a model session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneSeed {
    /// Hash of the authorized source snapshot, never the snapshot itself.
    pub source_snapshot_hash: String,
    /// Authoritative stream epoch from which the projection was produced.
    pub source_stream_epoch: u64,
    /// Deterministic generation seed.
    pub generation_seed: u64,
    /// Optional bounded prompt describing the simulation intent.
    pub prompt: Option<String>,
    /// Sanitized scene primitives only.
    pub scene: Vec<ScenePrimitive>,
    /// Privacy decision applied to this projection.
    pub privacy: PrivacyDecision,
    /// Bounded non-sensitive routing metadata.
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
}

impl SceneSeed {
    fn validate(&self) -> Result<(), WorldModelError> {
        if self.source_snapshot_hash.is_empty() || self.source_snapshot_hash.len() > 128 {
            return Err(WorldModelError::InvalidInput(
                "source snapshot hash must contain 1..=128 bytes".into(),
            ));
        }
        if self.privacy.projection_id.is_empty() || self.privacy.projection_id.len() > 128 {
            return Err(WorldModelError::InvalidInput(
                "projection id must contain 1..=128 bytes".into(),
            ));
        }
        if self.prompt.as_ref().is_some_and(|p| p.len() > 4_096) {
            return Err(WorldModelError::InvalidInput(
                "prompt exceeds 4096 bytes".into(),
            ));
        }
        if self.scene.len() > MAX_SCENE_PRIMITIVES {
            return Err(WorldModelError::InvalidInput(format!(
                "scene exceeds {MAX_SCENE_PRIMITIVES} primitives"
            )));
        }
        for primitive in &self.scene {
            let (values, class, sizes): (&[f32], &str, Option<&[f32]>) = match primitive {
                ScenePrimitive::Point {
                    x_m,
                    y_m,
                    z_m,
                    class,
                } => (&[*x_m, *y_m, *z_m], class, None),
                ScenePrimitive::Box {
                    center_m,
                    size_m,
                    class,
                } => (center_m, class, Some(size_m)),
            };
            if class.is_empty()
                || class.len() > 64
                || values.iter().any(|v| !v.is_finite())
                || sizes.is_some_and(|v| v.iter().any(|size| !size.is_finite() || *size <= 0.0))
            {
                return Err(WorldModelError::InvalidInput(
                    "scene primitive contains an invalid coordinate, size, or class".into(),
                ));
            }
        }
        validate_metadata(&self.metadata)
    }
}

/// One typed controller sample. It cannot carry raw sensor evidence.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActionSample {
    /// Offset from the start of this action chunk.
    pub offset_ms: u32,
    /// Local translation intent, clamped by the provider as appropriate.
    pub translation: [f32; 3],
    /// Local yaw/pitch/roll intent.
    pub rotation: [f32; 3],
    /// Named, scalar control inputs (for example `jump=1`).
    #[serde(default)]
    pub controls: BTreeMap<String, f32>,
}

/// Ordered action input for one session step.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActionChunk {
    /// Session epoch to which this action belongs.
    pub epoch: u64,
    /// Contiguous, zero-based sequence within the epoch.
    pub sequence: u64,
    /// Typed controller samples.
    pub samples: Vec<ActionSample>,
    /// Stable hash covering the complete action intent.
    pub action_hash: String,
    /// Bounded non-sensitive routing metadata.
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
}

impl ActionChunk {
    fn validate(&self) -> Result<(), WorldModelError> {
        if self.samples.is_empty() || self.samples.len() > MAX_ACTION_SAMPLES {
            return Err(WorldModelError::InvalidInput(format!(
                "action must contain 1..={MAX_ACTION_SAMPLES} samples"
            )));
        }
        if self.action_hash.is_empty() || self.action_hash.len() > 128 {
            return Err(WorldModelError::InvalidInput(
                "action hash must contain 1..=128 bytes".into(),
            ));
        }
        let mut previous_offset = 0;
        for sample in &self.samples {
            if sample.offset_ms < previous_offset || sample.offset_ms > MAX_ACTION_DURATION_MS {
                return Err(WorldModelError::InvalidInput(
                    "action sample offsets must be ordered and within the duration limit".into(),
                ));
            }
            previous_offset = sample.offset_ms;
            if sample.controls.len() > MAX_METADATA_ENTRIES
                || sample
                    .controls
                    .keys()
                    .any(|key| key.is_empty() || key.len() > MAX_METADATA_KEY_BYTES)
            {
                return Err(WorldModelError::InvalidInput(
                    "action controls exceed bounds".into(),
                ));
            }
            if sample
                .translation
                .iter()
                .chain(sample.rotation.iter())
                .chain(sample.controls.values())
                .any(|value| !value.is_finite())
            {
                return Err(WorldModelError::InvalidInput(
                    "action contains a non-finite scalar".into(),
                ));
            }
        }
        validate_metadata(&self.metadata)
    }
}

/// Rust-owned session sequencing state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelSession {
    /// Provider-issued opaque identifier.
    pub id: String,
    /// Epoch incremented by every successful reset.
    pub epoch: u64,
    /// Next contiguous action sequence expected in this epoch.
    pub next_sequence: u64,
    #[serde(skip)]
    context: Option<SessionContext>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SessionContext {
    source_snapshot_hash: String,
    source_stream_epoch: u64,
    generation_seed: u64,
    prompt_hash: u64,
    privacy: PrivacyDecision,
}

impl SessionContext {
    fn from_seed(seed: &SceneSeed) -> Self {
        Self {
            source_snapshot_hash: seed.source_snapshot_hash.clone(),
            source_stream_epoch: seed.source_stream_epoch,
            generation_seed: seed.generation_seed,
            prompt_hash: stable_hash(seed.prompt.as_deref().unwrap_or("").as_bytes()),
            privacy: seed.privacy.clone(),
        }
    }
}

impl ModelSession {
    fn validate_action(&self, action: &ActionChunk) -> Result<(), WorldModelError> {
        if action.epoch != self.epoch {
            return Err(WorldModelError::EpochMismatch {
                expected: self.epoch,
                actual: action.epoch,
            });
        }
        if action.sequence < self.next_sequence {
            return Err(WorldModelError::DuplicateSequence {
                expected: self.next_sequence,
                actual: action.sequence,
            });
        }
        if action.sequence > self.next_sequence {
            return Err(WorldModelError::SequenceGap {
                expected: self.next_sequence,
                actual: action.sequence,
            });
        }
        action.validate()
    }
}

/// Reference to generated media on a separate bounded media channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FrameDescriptor {
    /// `webrtc`, `shm`, `https`, or another deployment-approved scheme.
    pub transport: String,
    /// Opaque locator on that channel. Must not contain credentials.
    pub locator: String,
    /// Content digest for integrity and deterministic fixture comparison.
    pub content_hash: String,
    /// Encoded frame size, used for quota enforcement.
    pub byte_length: u64,
    /// Media type, such as `video/av1`.
    pub media_type: String,
}

/// Complete provenance attached to every simulated result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelProvenance {
    /// Provider implementation identifier.
    pub provider: String,
    /// Model family/name.
    pub model: String,
    /// Immutable checkpoint identifier or digest.
    pub checkpoint: String,
    /// Provider runtime version.
    pub runtime_version: String,
    /// Authorized source snapshot hash.
    pub source_snapshot_hash: String,
    /// Source graph stream epoch.
    pub source_stream_epoch: u64,
    /// Prompt/action digest.
    pub prompt_action_hash: String,
    /// Deterministic generation seed.
    pub generation_seed: u64,
    /// Generation sequence in the model session.
    pub generation_sequence: u64,
    /// Always true for this channel.
    pub simulated: bool,
    /// Provider confidence in `[0, 1]`.
    pub confidence: f32,
    /// Privacy decision applied at inference time.
    pub privacy: PrivacyDecision,
    /// Provider license active for this output.
    pub license: LicensePolicy,
}

/// Frames generated for one accepted action.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SimulatedFrameChunk {
    /// Media-channel descriptors in presentation order.
    pub frames: Vec<FrameDescriptor>,
    /// Generation metadata and safety provenance.
    pub provenance: ModelProvenance,
}

/// Transport envelope kept separate from graph snapshot/delta envelopes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SimulatedFrameEnvelope {
    /// Protocol schema version.
    pub schema_version: u32,
    /// Provider session identifier.
    pub session_id: String,
    /// Session epoch.
    pub epoch: u64,
    /// Action/generation sequence.
    pub sequence: u64,
    /// Generated frame chunk.
    pub chunk: SimulatedFrameChunk,
}

impl SimulatedFrameChunk {
    /// Wrap this chunk in the versioned media envelope.
    pub fn into_envelope(self, session: &ModelSession, sequence: u64) -> SimulatedFrameEnvelope {
        SimulatedFrameEnvelope {
            schema_version: 1,
            session_id: session.id.clone(),
            epoch: session.epoch,
            sequence,
            chunk: self,
        }
    }
}

/// Object-safe stateful provider contract.
pub trait GenerativeWorldModel: Send + Sync {
    /// Provider license enforced before inputs leave the process.
    fn license_policy(&self) -> &LicensePolicy;
    /// Starts a new session at epoch zero.
    fn initialize(&self, seed: SceneSeed) -> ModelFuture<'_, ModelSession>;
    /// Accepts exactly the next action and advances sequence only on success.
    fn step<'a>(
        &'a self,
        session: &'a mut ModelSession,
        action: ActionChunk,
    ) -> ModelFuture<'a, SimulatedFrameChunk>;
    /// Reinitializes provider state and increments the Rust-owned epoch.
    fn reset<'a>(&'a self, session: &'a mut ModelSession, seed: SceneSeed) -> ModelFuture<'a, ()>;
    /// Releases provider state.
    fn finish(&self, session: ModelSession) -> ModelFuture<'_, ()>;
}

/// Cloneable cancellation signal for external provider operations.
#[derive(Debug, Clone, Default)]
pub struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    /// Requests cancellation. In-flight sidecar I/O is dropped promptly.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    /// Returns whether cancellation has been requested.
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    async fn cancelled(&self) {
        while !self.is_cancelled() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}

/// Deterministic in-process provider for lifecycle and protocol tests.
#[derive(Debug)]
pub struct MockWorldModel {
    license: LicensePolicy,
    deployment: DeploymentPolicy,
    fail_on_sequence: Option<u64>,
    next_id: AtomicU64,
}

impl MockWorldModel {
    /// Creates a production-safe deterministic mock.
    pub fn new() -> Self {
        Self {
            license: LicensePolicy::apache_2_0(),
            deployment: DeploymentPolicy::production(),
            fail_on_sequence: None,
            next_id: AtomicU64::new(1),
        }
    }

    /// Creates a mock with explicit licensing/deployment policy.
    pub fn with_policy(license: LicensePolicy, deployment: DeploymentPolicy) -> Self {
        Self {
            license,
            deployment,
            fail_on_sequence: None,
            next_id: AtomicU64::new(1),
        }
    }

    /// Makes the selected action sequence fail deterministically.
    pub fn failing_on(mut self, sequence: u64) -> Self {
        self.fail_on_sequence = Some(sequence);
        self
    }
}

impl Default for MockWorldModel {
    fn default() -> Self {
        Self::new()
    }
}

impl GenerativeWorldModel for MockWorldModel {
    fn license_policy(&self) -> &LicensePolicy {
        &self.license
    }

    fn initialize(&self, seed: SceneSeed) -> ModelFuture<'_, ModelSession> {
        Box::pin(async move {
            self.license.enforce(&self.deployment)?;
            seed.validate()?;
            let id = self.next_id.fetch_add(1, Ordering::Relaxed);
            Ok(ModelSession {
                id: format!("mock-{id}"),
                epoch: 0,
                next_sequence: 0,
                context: Some(SessionContext::from_seed(&seed)),
            })
        })
    }

    fn step<'a>(
        &'a self,
        session: &'a mut ModelSession,
        action: ActionChunk,
    ) -> ModelFuture<'a, SimulatedFrameChunk> {
        Box::pin(async move {
            self.license.enforce(&self.deployment)?;
            session.validate_action(&action)?;
            if self.fail_on_sequence == Some(action.sequence) {
                return Err(WorldModelError::Provider(format!(
                    "deterministic failure at sequence {}",
                    action.sequence
                )));
            }
            let sequence = action.sequence;
            let context = session.context.as_ref().ok_or_else(|| {
                WorldModelError::Provider("session provenance context missing".into())
            })?;
            let hash = format!(
                "mock:{:016x}:{:016x}:{:016x}",
                action.epoch,
                sequence,
                stable_hash(action.action_hash.as_bytes())
            );
            let chunk = SimulatedFrameChunk {
                frames: vec![FrameDescriptor {
                    transport: "mock".into(),
                    locator: format!("mock://{}/{}/{}", session.id, session.epoch, sequence),
                    content_hash: hash,
                    byte_length: 0,
                    media_type: "application/x.worldgraph-mock-frame".into(),
                }],
                provenance: ModelProvenance {
                    provider: "mock".into(),
                    model: "deterministic-fixture".into(),
                    checkpoint: "builtin-v1".into(),
                    runtime_version: env!("CARGO_PKG_VERSION").into(),
                    source_snapshot_hash: context.source_snapshot_hash.clone(),
                    source_stream_epoch: context.source_stream_epoch,
                    prompt_action_hash: format!(
                        "mock:{:016x}:{:016x}",
                        context.prompt_hash,
                        stable_hash(action.action_hash.as_bytes())
                    ),
                    generation_seed: context.generation_seed,
                    generation_sequence: sequence,
                    simulated: true,
                    confidence: 1.0,
                    privacy: context.privacy.clone(),
                    license: self.license.clone(),
                },
            };
            session.next_sequence += 1;
            Ok(chunk)
        })
    }

    fn reset<'a>(&'a self, session: &'a mut ModelSession, seed: SceneSeed) -> ModelFuture<'a, ()> {
        Box::pin(async move {
            self.license.enforce(&self.deployment)?;
            seed.validate()?;
            let context = SessionContext::from_seed(&seed);
            session.epoch = session
                .epoch
                .checked_add(1)
                .ok_or_else(|| WorldModelError::Provider("session epoch exhausted".into()))?;
            session.next_sequence = 0;
            session.context = Some(context);
            Ok(())
        })
    }

    fn finish(&self, _session: ModelSession) -> ModelFuture<'_, ()> {
        Box::pin(async move { self.license.enforce(&self.deployment) })
    }
}

/// External sidecar transport configuration.
#[derive(Debug, Clone)]
pub struct SidecarConfig {
    /// Unix-domain control socket. Frame bytes use descriptors in responses.
    pub socket_path: PathBuf,
    /// Deadline for each lifecycle operation.
    pub timeout: Duration,
    /// Admission policy for the provider license.
    pub deployment: DeploymentPolicy,
    /// Shared cancellation token.
    pub cancellation: CancellationToken,
    /// Whether this worker is a hosted/external data processor. Hosted use
    /// requires explicit approval in each [`PrivacyDecision`].
    pub hosted: bool,
}

/// Stateful newline-delimited JSON control client for an external GPU worker.
///
/// Only bounded control metadata crosses this socket. Frame bytes are carried
/// by the transport named in [`FrameDescriptor`].
#[derive(Debug, Clone)]
pub struct ExternalSidecarProvider {
    config: SidecarConfig,
    license: LicensePolicy,
}

impl ExternalSidecarProvider {
    /// Creates a sidecar provider. Licensing is checked again on every call.
    pub fn new(config: SidecarConfig, license: LicensePolicy) -> Self {
        Self { config, license }
    }
    /// Returns the cancellation signal used by this provider.
    pub fn cancellation_token(&self) -> CancellationToken {
        self.config.cancellation.clone()
    }

    async fn request(&self, request: SidecarRequest) -> Result<SidecarResponse, WorldModelError> {
        self.license.enforce(&self.config.deployment)?;
        if self.config.cancellation.is_cancelled() {
            return Err(WorldModelError::Cancelled);
        }
        let operation = self.request_inner(SidecarControlRequest {
            schema_version: 1,
            request,
        });
        tokio::select! {
            _ = self.config.cancellation.cancelled() => Err(WorldModelError::Cancelled),
            result = tokio::time::timeout(self.config.timeout, operation) => {
                result.map_err(|_| WorldModelError::Timeout { timeout_s: self.config.timeout.as_secs().max(1) })?
            }
        }
    }

    #[cfg(unix)]
    async fn request_inner(
        &self,
        request: SidecarControlRequest,
    ) -> Result<SidecarResponse, WorldModelError> {
        let stream = UnixStream::connect(&self.config.socket_path)
            .await
            .map_err(|source| WorldModelError::SocketConnect {
                path: self.config.socket_path.display().to_string(),
                source,
            })?;
        let (reader, mut writer) = stream.into_split();
        let mut payload = serde_json::to_vec(&request)?;
        if payload.len() > MAX_SIDECAR_CONTROL_BYTES {
            return Err(WorldModelError::InvalidInput(format!(
                "sidecar request exceeds {MAX_SIDECAR_CONTROL_BYTES} bytes"
            )));
        }
        payload.push(b'\n');
        writer
            .write_all(&payload)
            .await
            .map_err(|e| WorldModelError::Provider(format!("sidecar write failed: {e}")))?;
        writer
            .flush()
            .await
            .map_err(|e| WorldModelError::Provider(format!("sidecar flush failed: {e}")))?;
        let mut limited = BufReader::new(reader).take((MAX_SIDECAR_CONTROL_BYTES + 1) as u64);
        let mut line = Vec::new();
        limited
            .read_until(b'\n', &mut line)
            .await
            .map_err(|e| WorldModelError::Provider(format!("sidecar read failed: {e}")))?;
        if line.is_empty() {
            return Err(WorldModelError::Protocol(
                "sidecar closed before a response".into(),
            ));
        }
        if line.len() > MAX_SIDECAR_CONTROL_BYTES {
            return Err(WorldModelError::Protocol(
                "sidecar response exceeds control-message limit".into(),
            ));
        }
        let response: SidecarControlResponse = serde_json::from_slice(&line)?;
        if response.schema_version != 1 {
            return Err(WorldModelError::Protocol(format!(
                "unsupported sidecar schema version {}",
                response.schema_version
            )));
        }
        response.response.validate()?;
        Ok(response.response)
    }

    #[cfg(not(unix))]
    async fn request_inner(
        &self,
        _request: SidecarControlRequest,
    ) -> Result<SidecarResponse, WorldModelError> {
        Err(WorldModelError::Protocol(
            "external sidecar Unix socket is only supported on unix targets".into(),
        ))
    }
}

impl GenerativeWorldModel for ExternalSidecarProvider {
    fn license_policy(&self) -> &LicensePolicy {
        &self.license
    }

    fn initialize(&self, seed: SceneSeed) -> ModelFuture<'_, ModelSession> {
        Box::pin(async move {
            seed.validate()?;
            if self.config.hosted && !seed.privacy.hosted_processing_approved {
                return Err(WorldModelError::InvalidInput(
                    "hosted provider processing was not approved by the privacy decision".into(),
                ));
            }
            let context = SessionContext::from_seed(&seed);
            match self.request(SidecarRequest::Initialize { seed }).await? {
                SidecarResponse::Initialized { session_id }
                    if !session_id.is_empty() && session_id.len() <= 128 =>
                {
                    Ok(ModelSession {
                        id: session_id,
                        epoch: 0,
                        next_sequence: 0,
                        context: Some(context),
                    })
                }
                SidecarResponse::Error { message } => Err(WorldModelError::Provider(message)),
                _ => Err(WorldModelError::Protocol(
                    "unexpected initialize response".into(),
                )),
            }
        })
    }

    fn step<'a>(
        &'a self,
        session: &'a mut ModelSession,
        action: ActionChunk,
    ) -> ModelFuture<'a, SimulatedFrameChunk> {
        Box::pin(async move {
            session.validate_action(&action)?;
            let sequence = action.sequence;
            let action_hash = action.action_hash.clone();
            match self
                .request(SidecarRequest::Step {
                    session: session.clone(),
                    action,
                })
                .await?
            {
                SidecarResponse::Stepped {
                    epoch,
                    sequence: returned_sequence,
                    mut chunk,
                } if epoch == session.epoch && returned_sequence == sequence => {
                    validate_chunk(&chunk)?;
                    bind_local_provenance(
                        &mut chunk,
                        session,
                        &action_hash,
                        sequence,
                        &self.license,
                    )?;
                    session.next_sequence += 1;
                    Ok(*chunk)
                }
                SidecarResponse::Error { message } => Err(WorldModelError::Provider(message)),
                SidecarResponse::Stepped { .. } => Err(WorldModelError::Protocol(
                    "sidecar returned the wrong epoch or sequence".into(),
                )),
                _ => Err(WorldModelError::Protocol("unexpected step response".into())),
            }
        })
    }

    fn reset<'a>(&'a self, session: &'a mut ModelSession, seed: SceneSeed) -> ModelFuture<'a, ()> {
        Box::pin(async move {
            seed.validate()?;
            if self.config.hosted && !seed.privacy.hosted_processing_approved {
                return Err(WorldModelError::InvalidInput(
                    "hosted provider processing was not approved by the privacy decision".into(),
                ));
            }
            let context = SessionContext::from_seed(&seed);
            let next_epoch = session
                .epoch
                .checked_add(1)
                .ok_or_else(|| WorldModelError::Provider("session epoch exhausted".into()))?;
            match self
                .request(SidecarRequest::Reset {
                    session: session.clone(),
                    next_epoch,
                    seed,
                })
                .await?
            {
                SidecarResponse::Reset { epoch } if epoch == next_epoch => {
                    session.epoch = next_epoch;
                    session.next_sequence = 0;
                    session.context = Some(context);
                    Ok(())
                }
                SidecarResponse::Error { message } => Err(WorldModelError::Provider(message)),
                _ => Err(WorldModelError::Protocol(
                    "unexpected reset response".into(),
                )),
            }
        })
    }

    fn finish(&self, session: ModelSession) -> ModelFuture<'_, ()> {
        Box::pin(async move {
            match self.request(SidecarRequest::Finish { session }).await? {
                SidecarResponse::Finished => Ok(()),
                SidecarResponse::Error { message } => Err(WorldModelError::Provider(message)),
                _ => Err(WorldModelError::Protocol(
                    "unexpected finish response".into(),
                )),
            }
        })
    }
}

/// Versioned sidecar control request. Public so workers can share the schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum SidecarRequest {
    /// Create provider state.
    Initialize {
        /// Authorized initialization projection.
        seed: SceneSeed,
    },
    /// Advance provider state.
    Step {
        /// Current Rust-owned session state.
        session: ModelSession,
        /// Next contiguous typed action.
        action: ActionChunk,
    },
    /// Clear caches and enter the supplied epoch.
    Reset {
        /// Current Rust-owned session state.
        session: ModelSession,
        /// Epoch the worker must enter on success.
        next_epoch: u64,
        /// Replacement authorized projection.
        seed: SceneSeed,
    },
    /// Release provider state.
    Finish {
        /// Session state to release.
        session: ModelSession,
    },
}

/// Versioned sidecar request envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidecarControlRequest {
    /// Control protocol schema version; currently `1`.
    pub schema_version: u32,
    /// Lifecycle operation.
    pub request: SidecarRequest,
}

/// Versioned sidecar control response. Media bytes are never embedded here.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum SidecarResponse {
    /// Successful initialization.
    Initialized {
        /// Opaque provider-issued session identifier.
        session_id: String,
    },
    /// Successful action step.
    Stepped {
        /// Epoch of the generated result.
        epoch: u64,
        /// Sequence of the generated result.
        sequence: u64,
        /// Generated media descriptors and provenance.
        chunk: Box<SimulatedFrameChunk>,
    },
    /// Successful reset.
    Reset {
        /// Epoch entered by the worker.
        epoch: u64,
    },
    /// Successful finish.
    Finished,
    /// Provider-declared failure.
    Error {
        /// Bounded provider-safe error detail.
        message: String,
    },
}

/// Versioned sidecar response envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidecarControlResponse {
    /// Control protocol schema version; currently `1`.
    pub schema_version: u32,
    /// Operation result.
    pub response: SidecarResponse,
}

impl SidecarResponse {
    fn validate(&self) -> Result<(), WorldModelError> {
        match self {
            Self::Initialized { session_id } if session_id.len() > 128 => Err(
                WorldModelError::Protocol("sidecar session id exceeds 128 bytes".into()),
            ),
            Self::Stepped { chunk, .. } => validate_chunk(chunk),
            Self::Error { message } if message.len() > 4_096 => Err(WorldModelError::Protocol(
                "sidecar error message exceeds 4096 bytes".into(),
            )),
            _ => Ok(()),
        }
    }
}

fn validate_metadata(metadata: &BTreeMap<String, String>) -> Result<(), WorldModelError> {
    if metadata.len() > MAX_METADATA_ENTRIES {
        return Err(WorldModelError::InvalidInput(format!(
            "metadata exceeds {MAX_METADATA_ENTRIES} entries"
        )));
    }
    if metadata.iter().any(|(key, value)| {
        key.is_empty()
            || key.len() > MAX_METADATA_KEY_BYTES
            || value.len() > MAX_METADATA_VALUE_BYTES
    }) {
        return Err(WorldModelError::InvalidInput(
            "metadata key/value exceeds bounds".into(),
        ));
    }
    Ok(())
}

fn validate_chunk(chunk: &SimulatedFrameChunk) -> Result<(), WorldModelError> {
    if chunk.frames.len() > MAX_FRAME_DESCRIPTORS {
        return Err(WorldModelError::Protocol(
            "sidecar returned too many frame descriptors".into(),
        ));
    }
    let advertised_bytes = chunk.frames.iter().try_fold(0_u64, |sum, frame| {
        sum.checked_add(frame.byte_length)
            .ok_or_else(|| WorldModelError::Protocol("frame byte quota overflow".into()))
    })?;
    if advertised_bytes > MAX_FRAME_BYTES_PER_CHUNK {
        return Err(WorldModelError::Protocol(format!(
            "sidecar frame chunk exceeds {MAX_FRAME_BYTES_PER_CHUNK} advertised bytes"
        )));
    }
    if !chunk.provenance.simulated {
        return Err(WorldModelError::Protocol(
            "generated output must be marked simulated".into(),
        ));
    }
    if !chunk.provenance.confidence.is_finite()
        || !(0.0..=1.0).contains(&chunk.provenance.confidence)
    {
        return Err(WorldModelError::Protocol(
            "provider confidence must be finite and in [0,1]".into(),
        ));
    }
    for value in [
        &chunk.provenance.provider,
        &chunk.provenance.model,
        &chunk.provenance.checkpoint,
        &chunk.provenance.runtime_version,
        &chunk.provenance.source_snapshot_hash,
        &chunk.provenance.prompt_action_hash,
    ] {
        if value.is_empty() || value.len() > 256 {
            return Err(WorldModelError::Protocol(
                "provider provenance field must contain 1..=256 bytes".into(),
            ));
        }
    }
    for frame in &chunk.frames {
        if frame.transport.is_empty()
            || frame.transport.len() > 32
            || frame.locator.is_empty()
            || frame.locator.len() > 2_048
            || frame.content_hash.is_empty()
            || frame.content_hash.len() > 128
            || frame.media_type.len() > 128
            || locator_has_credentials(&frame.locator)
        {
            return Err(WorldModelError::Protocol(
                "frame descriptor exceeds bounds".into(),
            ));
        }
    }
    Ok(())
}

fn bind_local_provenance(
    chunk: &mut SimulatedFrameChunk,
    session: &ModelSession,
    action_hash: &str,
    sequence: u64,
    license: &LicensePolicy,
) -> Result<(), WorldModelError> {
    let context = session
        .context
        .as_ref()
        .ok_or_else(|| WorldModelError::Provider("session provenance context missing".into()))?;
    chunk.provenance.source_snapshot_hash = context.source_snapshot_hash.clone();
    chunk.provenance.source_stream_epoch = context.source_stream_epoch;
    chunk.provenance.prompt_action_hash = format!(
        "worldgraph:{:016x}:{:016x}",
        context.prompt_hash,
        stable_hash(action_hash.as_bytes())
    );
    chunk.provenance.generation_seed = context.generation_seed;
    chunk.provenance.generation_sequence = sequence;
    chunk.provenance.simulated = true;
    chunk.provenance.privacy = context.privacy.clone();
    chunk.provenance.license = license.clone();
    Ok(())
}

fn locator_has_credentials(locator: &str) -> bool {
    let Some((_, rest)) = locator.split_once("://") else {
        return false;
    };
    rest.split('/')
        .next()
        .is_some_and(|authority| authority.contains('@'))
}

fn stable_hash(bytes: &[u8]) -> u64 {
    // FNV-1a is intentionally simple and stable for fixtures, not cryptographic.
    bytes.iter().fold(0xcbf29ce484222325_u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed() -> SceneSeed {
        SceneSeed {
            source_snapshot_hash: "sha256:snapshot".into(),
            source_stream_epoch: 7,
            generation_seed: 42,
            prompt: Some("walk forward".into()),
            scene: vec![ScenePrimitive::Point {
                x_m: 1.0,
                y_m: 2.0,
                z_m: 0.0,
                class: "anonymous_person".into(),
            }],
            privacy: PrivacyDecision {
                projection_id: "operator-redacted".into(),
                hosted_processing_approved: false,
                redactions_applied: 3,
                retention: RetentionPolicy::Ephemeral,
            },
            metadata: BTreeMap::new(),
        }
    }

    fn action(epoch: u64, sequence: u64) -> ActionChunk {
        ActionChunk {
            epoch,
            sequence,
            samples: vec![ActionSample {
                offset_ms: 0,
                translation: [0.0, 0.0, 1.0],
                rotation: [0.0; 3],
                controls: BTreeMap::new(),
            }],
            action_hash: format!("action-{sequence}"),
            metadata: BTreeMap::new(),
        }
    }

    #[tokio::test]
    async fn mock_lifecycle_and_deterministic_frames() {
        let model = MockWorldModel::new();
        let mut first = model.initialize(seed()).await.unwrap();
        let mut second = model.initialize(seed()).await.unwrap();
        let a = model.step(&mut first, action(0, 0)).await.unwrap();
        let b = model.step(&mut second, action(0, 0)).await.unwrap();
        assert_eq!(a.frames[0].content_hash, b.frames[0].content_hash);
        assert_eq!(a.provenance.source_snapshot_hash, "sha256:snapshot");
        assert_eq!(a.provenance.source_stream_epoch, 7);
        assert_eq!(a.provenance.generation_seed, 42);
        assert_eq!(a.provenance.privacy, seed().privacy);
        assert_eq!(first.next_sequence, 1);
        model.reset(&mut first, seed()).await.unwrap();
        assert_eq!((first.epoch, first.next_sequence), (1, 0));
        model.step(&mut first, action(1, 0)).await.unwrap();
        model.finish(first).await.unwrap();
    }

    #[tokio::test]
    async fn rejects_duplicate_gap_and_wrong_epoch() {
        let model = MockWorldModel::new();
        let mut session = model.initialize(seed()).await.unwrap();
        model.step(&mut session, action(0, 0)).await.unwrap();
        assert!(matches!(
            model.step(&mut session, action(0, 0)).await.unwrap_err(),
            WorldModelError::DuplicateSequence { .. }
        ));
        assert!(matches!(
            model.step(&mut session, action(0, 2)).await.unwrap_err(),
            WorldModelError::SequenceGap { .. }
        ));
        assert!(matches!(
            model.step(&mut session, action(1, 1)).await.unwrap_err(),
            WorldModelError::EpochMismatch { .. }
        ));
    }

    #[tokio::test]
    async fn provider_failure_does_not_advance_sequence() {
        let model = MockWorldModel::new().failing_on(0);
        let mut session = model.initialize(seed()).await.unwrap();
        assert!(matches!(
            model.step(&mut session, action(0, 0)).await.unwrap_err(),
            WorldModelError::Provider(_)
        ));
        assert_eq!(session.next_sequence, 0);
    }

    #[tokio::test]
    async fn research_license_requires_environment_and_opt_in() {
        let license = LicensePolicy {
            license_id: "CC-BY-NC-SA-4.0".into(),
            usage: LicenseUsage::ResearchOnly,
            redistribution_allowed: false,
            attribution_required: true,
            notice: Some("LingBot research-only release".into()),
        };
        let production =
            MockWorldModel::with_policy(license.clone(), DeploymentPolicy::production());
        assert!(matches!(
            production.initialize(seed()).await.unwrap_err(),
            WorldModelError::LicenseDenied { .. }
        ));
        let no_opt_in = MockWorldModel::with_policy(
            license.clone(),
            DeploymentPolicy {
                environment: DeploymentEnvironment::NonCommercialResearch,
                allow_research_only: false,
            },
        );
        assert!(matches!(
            no_opt_in.initialize(seed()).await.unwrap_err(),
            WorldModelError::LicenseDenied { .. }
        ));
        let allowed = MockWorldModel::with_policy(
            license,
            DeploymentPolicy {
                environment: DeploymentEnvironment::NonCommercialResearch,
                allow_research_only: true,
            },
        );
        allowed.initialize(seed()).await.unwrap();
    }

    #[tokio::test]
    async fn inputs_are_bounded_and_non_finite_actions_rejected() {
        let model = MockWorldModel::new();
        let mut invalid_seed = seed();
        invalid_seed
            .metadata
            .insert("x".into(), "x".repeat(MAX_METADATA_VALUE_BYTES + 1));
        assert!(matches!(
            model.initialize(invalid_seed).await.unwrap_err(),
            WorldModelError::InvalidInput(_)
        ));
        let mut session = model.initialize(seed()).await.unwrap();
        let mut invalid_action = action(0, 0);
        invalid_action.samples[0].translation[0] = f32::NAN;
        assert!(matches!(
            model.step(&mut session, invalid_action).await.unwrap_err(),
            WorldModelError::InvalidInput(_)
        ));
    }

    #[test]
    fn trait_is_object_safe_and_protocol_is_machine_readable() {
        let model: Box<dyn GenerativeWorldModel> = Box::new(MockWorldModel::new());
        assert_eq!(model.license_policy().license_id, "Apache-2.0");
        let json = serde_json::to_value(model.license_policy()).unwrap();
        assert_eq!(json["usage"], "production");
        let request = SidecarControlRequest {
            schema_version: 1,
            request: SidecarRequest::Step {
                session: ModelSession {
                    id: "s".into(),
                    epoch: 2,
                    next_sequence: 4,
                    context: None,
                },
                action: action(2, 4),
            },
        };
        let json = serde_json::to_string(&request).unwrap();
        assert!(json.contains("\"schema_version\":1"));
        assert!(json.contains("\"operation\":\"step\""));
        assert!(!json.contains("frame_bytes"));
    }

    #[test]
    fn output_quota_and_locator_credentials_are_rejected() {
        let model = MockWorldModel::new();
        let mut chunk = SimulatedFrameChunk {
            frames: vec![FrameDescriptor {
                transport: "https".into(),
                locator: "https://user:secret@example.invalid/frame".into(),
                content_hash: "sha256:x".into(),
                byte_length: 1,
                media_type: "video/av1".into(),
            }],
            provenance: ModelProvenance {
                provider: "test".into(),
                model: "test".into(),
                checkpoint: "test".into(),
                runtime_version: "1".into(),
                source_snapshot_hash: "x".into(),
                source_stream_epoch: 0,
                prompt_action_hash: "x".into(),
                generation_seed: 0,
                generation_sequence: 0,
                simulated: true,
                confidence: 1.0,
                privacy: seed().privacy,
                license: model.license_policy().clone(),
            },
        };
        assert!(matches!(
            validate_chunk(&chunk),
            Err(WorldModelError::Protocol(_))
        ));
        chunk.frames[0].locator = "https://example.invalid/frame".into();
        chunk.frames[0].byte_length = MAX_FRAME_BYTES_PER_CHUNK + 1;
        assert!(matches!(
            validate_chunk(&chunk),
            Err(WorldModelError::Protocol(_))
        ));
    }

    #[cfg(unix)]
    fn sidecar_config(socket_path: PathBuf, timeout: Duration) -> SidecarConfig {
        SidecarConfig {
            socket_path,
            timeout,
            deployment: DeploymentPolicy::production(),
            cancellation: CancellationToken::default(),
            hosted: false,
        }
    }

    #[cfg(unix)]
    fn unique_socket(label: &str) -> PathBuf {
        PathBuf::from("/tmp").join(format!(
            "worldgraph-worldmodel-{label}-{}-{}.sock",
            std::process::id(),
            stable_hash(label.as_bytes())
        ))
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sidecar_deadline_and_cancellation_are_enforced() {
        use tokio::net::UnixListener;

        let socket = unique_socket("timeout");
        let listener = UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
        });
        let provider = ExternalSidecarProvider::new(
            sidecar_config(socket.clone(), Duration::from_millis(10)),
            LicensePolicy::apache_2_0(),
        );
        assert!(matches!(
            provider.initialize(seed()).await.unwrap_err(),
            WorldModelError::Timeout { .. }
        ));
        server.await.unwrap();
        std::fs::remove_file(&socket).unwrap();

        let cancelled = CancellationToken::default();
        cancelled.cancel();
        let provider = ExternalSidecarProvider::new(
            SidecarConfig {
                socket_path: unique_socket("cancelled"),
                timeout: Duration::from_secs(1),
                deployment: DeploymentPolicy::production(),
                cancellation: cancelled,
                hosted: false,
            },
            LicensePolicy::apache_2_0(),
        );
        assert!(matches!(
            provider.initialize(seed()).await.unwrap_err(),
            WorldModelError::Cancelled
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sidecar_full_lifecycle_uses_versioned_control_protocol() {
        use tokio::net::UnixListener;

        let socket = unique_socket("lifecycle");
        let listener = UnixListener::bind(&socket).unwrap();
        let server_license = LicensePolicy::apache_2_0();
        let server = tokio::spawn(async move {
            for _ in 0..4 {
                let (stream, _) = listener.accept().await.unwrap();
                let (reader, mut writer) = stream.into_split();
                let mut line = String::new();
                BufReader::new(reader).read_line(&mut line).await.unwrap();
                let request: SidecarControlRequest = serde_json::from_str(&line).unwrap();
                assert_eq!(request.schema_version, 1);
                let response = match request.request {
                    SidecarRequest::Initialize { .. } => SidecarResponse::Initialized {
                        session_id: "gpu-1".into(),
                    },
                    SidecarRequest::Step { session, action } => SidecarResponse::Stepped {
                        epoch: session.epoch,
                        sequence: action.sequence,
                        chunk: Box::new(SimulatedFrameChunk {
                            frames: vec![FrameDescriptor {
                                transport: "shm".into(),
                                locator: "shm://worldgraph/frame-0".into(),
                                content_hash: "sha256:frame".into(),
                                byte_length: 1024,
                                media_type: "video/av1".into(),
                            }],
                            provenance: ModelProvenance {
                                provider: "test-sidecar".into(),
                                model: "fixture".into(),
                                checkpoint: "fixture-v1".into(),
                                runtime_version: "1.0".into(),
                                source_snapshot_hash: "worker-value".into(),
                                source_stream_epoch: 0,
                                prompt_action_hash: "worker-value".into(),
                                generation_seed: 0,
                                generation_sequence: 0,
                                simulated: true,
                                confidence: 0.9,
                                privacy: PrivacyDecision {
                                    projection_id: "worker-value".into(),
                                    hosted_processing_approved: false,
                                    redactions_applied: 0,
                                    retention: RetentionPolicy::PolicyBound,
                                },
                                license: server_license.clone(),
                            },
                        }),
                    },
                    SidecarRequest::Reset { next_epoch, .. } => {
                        SidecarResponse::Reset { epoch: next_epoch }
                    }
                    SidecarRequest::Finish { .. } => SidecarResponse::Finished,
                };
                let mut payload = serde_json::to_vec(&SidecarControlResponse {
                    schema_version: 1,
                    response,
                })
                .unwrap();
                payload.push(b'\n');
                writer.write_all(&payload).await.unwrap();
            }
        });

        let provider = ExternalSidecarProvider::new(
            sidecar_config(socket.clone(), Duration::from_secs(1)),
            LicensePolicy::apache_2_0(),
        );
        let expected_privacy = seed().privacy;
        let mut session = provider.initialize(seed()).await.unwrap();
        let chunk = provider.step(&mut session, action(0, 0)).await.unwrap();
        assert_eq!(session.next_sequence, 1);
        assert_eq!(chunk.provenance.source_snapshot_hash, "sha256:snapshot");
        assert_eq!(chunk.provenance.source_stream_epoch, 7);
        assert_eq!(chunk.provenance.generation_seed, 42);
        assert_eq!(chunk.provenance.generation_sequence, 0);
        assert_eq!(chunk.provenance.privacy, expected_privacy);
        provider.reset(&mut session, seed()).await.unwrap();
        assert_eq!((session.epoch, session.next_sequence), (1, 0));
        provider.finish(session).await.unwrap();
        server.await.unwrap();
        std::fs::remove_file(socket).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn hosted_sidecar_requires_explicit_privacy_approval() {
        let provider = ExternalSidecarProvider::new(
            SidecarConfig {
                socket_path: unique_socket("hosted"),
                timeout: Duration::from_secs(1),
                deployment: DeploymentPolicy::production(),
                cancellation: CancellationToken::default(),
                hosted: true,
            },
            LicensePolicy::apache_2_0(),
        );
        assert!(matches!(
            provider.initialize(seed()).await.unwrap_err(),
            WorldModelError::InvalidInput(_)
        ));
    }
}
