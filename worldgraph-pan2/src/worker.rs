//! GPU-side sidecar worker for the ADR-204 control protocol.
//!
//! The worker listens on a Unix socket and answers one newline-delimited JSON
//! request per connection, exactly as
//! [`wifi_densepose_worldmodel::ExternalSidecarProvider`] expects. It keeps
//! session state, compiles each step into a PAN 2 prompt, hands it to a
//! [`Renderer`], hashes the files the renderer wrote, and returns descriptors.
//! Video bytes never cross the socket.
//!
//! The renderer is a trait so the protocol, session rules and provenance can
//! be tested without a GPU.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Mutex;
use wifi_densepose_worldmodel::runtime::MAX_SIDECAR_CONTROL_BYTES;
use wifi_densepose_worldmodel::{
    ActionChunk, ExternalModelKind, FrameDescriptor, ModelProvenance, ModelSession, SceneSeed,
    SidecarControlRequest, SidecarControlResponse, SidecarRequest, SidecarResponse,
    SimulatedFrameChunk,
};

use crate::compile::{compile, CompiledPrompt};
use crate::media::{check_component, locator, sha256_file, MEDIA_TRANSPORT};
use crate::Pan2Error;

/// Most sessions a worker keeps before refusing new ones.
pub const MAX_SESSIONS: usize = 64;
/// File name of the generated clip inside a step directory.
pub const CLIP_FILE: &str = "clip.mp4";
/// File name of the exact caption sent to the model.
pub const CAPTION_FILE: &str = "caption.json";
/// File name of the measured generation record.
pub const GENERATION_FILE: &str = "generation.json";

/// Boxed future returned by [`Renderer::render`].
pub type RenderFuture<'a> =
    Pin<Box<dyn Future<Output = Result<RenderStats, Pan2Error>> + Send + 'a>>;

/// One clip to generate.
#[derive(Debug, Clone)]
pub struct RenderJob {
    /// Compiled caption, duration and task.
    pub prompt: CompiledPrompt,
    /// Deterministic sampler seed.
    pub generation_seed: u64,
    /// Directory the renderer must write [`CLIP_FILE`] into. Already created.
    pub step_dir: PathBuf,
    /// Verified conditioning image for image-to-video.
    pub image_path: Option<PathBuf>,
}

/// Measurements a renderer reports for one clip. All values are measured.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RenderStats {
    /// Wall-clock seconds for the whole generator invocation, model load included.
    pub seconds: f64,
    /// Sampler steps used.
    pub steps: u32,
    /// GPU model reported by the driver, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hardware: Option<String>,
    /// Peak GPU memory in gibibytes sampled during the run, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peak_vram_gb: Option<f64>,
}

/// What produced the pixels; copied into every provenance record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RendererIdentity {
    /// Model family, for example `IFM/PAN2`.
    pub model: String,
    /// Immutable checkpoint identifier, for example a Hugging Face revision.
    pub checkpoint: String,
    /// Runtime identifier, for example the upstream repository commit.
    pub runtime_version: String,
}

/// Turns a compiled prompt into a clip on disk.
pub trait Renderer: Send + Sync {
    /// Identity recorded in provenance.
    fn identity(&self) -> RendererIdentity;
    /// Writes [`CLIP_FILE`] into `job.step_dir`.
    fn render<'a>(&'a self, job: &'a RenderJob) -> RenderFuture<'a>;
}

struct SessionState {
    epoch: u64,
    seed: SceneSeed,
}

/// Session-keeping protocol handler, independent of the socket.
pub struct Worker<R> {
    renderer: R,
    media_root: PathBuf,
    image_root: PathBuf,
    sessions: Mutex<BTreeMap<String, SessionState>>,
    render_lock: Mutex<()>,
    next_id: AtomicU64,
    instance: String,
}

impl<R: Renderer> Worker<R> {
    /// Creates a worker that writes clips under `media_root` and reads
    /// conditioning images from `image_root`.
    ///
    /// `instance` makes session ids unique across worker restarts; it must be
    /// letters, digits, `_` or `-`.
    pub fn new(
        renderer: R,
        media_root: impl Into<PathBuf>,
        image_root: impl Into<PathBuf>,
        instance: &str,
    ) -> Result<Self, Pan2Error> {
        check_component(instance)?;
        Ok(Self {
            renderer,
            media_root: media_root.into(),
            image_root: image_root.into(),
            sessions: Mutex::new(BTreeMap::new()),
            render_lock: Mutex::new(()),
            next_id: AtomicU64::new(1),
            instance: instance.to_owned(),
        })
    }

    /// Handles one control request. Failures become [`SidecarResponse::Error`].
    pub async fn handle(&self, request: SidecarRequest) -> SidecarResponse {
        let result = match request {
            SidecarRequest::Initialize { seed } => self.initialize(seed).await,
            SidecarRequest::Step { session, action } => self.step(session, action).await,
            SidecarRequest::Reset {
                session,
                next_epoch,
                seed,
            } => self.reset(session, next_epoch, seed).await,
            SidecarRequest::Finish { session } => self.finish(session).await,
        };
        result.unwrap_or_else(|error| {
            let mut message = error.to_string();
            message.truncate(1_024);
            SidecarResponse::Error { message }
        })
    }

    async fn initialize(&self, seed: SceneSeed) -> Result<SidecarResponse, Pan2Error> {
        let mut sessions = self.sessions.lock().await;
        if sessions.len() >= MAX_SESSIONS {
            return Err(Pan2Error::invalid("worker session limit reached"));
        }
        let session_id = format!(
            "pan2-{}-{}",
            self.instance,
            self.next_id.fetch_add(1, Ordering::Relaxed)
        );
        sessions.insert(session_id.clone(), SessionState { epoch: 0, seed });
        Ok(SidecarResponse::Initialized { session_id })
    }

    async fn reset(
        &self,
        session: ModelSession,
        next_epoch: u64,
        seed: SceneSeed,
    ) -> Result<SidecarResponse, Pan2Error> {
        let mut sessions = self.sessions.lock().await;
        let state = sessions
            .get_mut(&session.id)
            .ok_or_else(|| Pan2Error::invalid("unknown session"))?;
        if session.epoch != state.epoch || next_epoch != state.epoch + 1 {
            return Err(Pan2Error::invalid(
                "reset does not follow the current epoch",
            ));
        }
        *state = SessionState {
            epoch: next_epoch,
            seed,
        };
        Ok(SidecarResponse::Reset { epoch: next_epoch })
    }

    async fn finish(&self, session: ModelSession) -> Result<SidecarResponse, Pan2Error> {
        self.sessions.lock().await.remove(&session.id);
        Ok(SidecarResponse::Finished)
    }

    async fn step(
        &self,
        session: ModelSession,
        action: ActionChunk,
    ) -> Result<SidecarResponse, Pan2Error> {
        let seed = {
            let sessions = self.sessions.lock().await;
            let state = sessions
                .get(&session.id)
                .ok_or_else(|| Pan2Error::invalid("unknown session"))?;
            if session.epoch != state.epoch || action.epoch != state.epoch {
                return Err(Pan2Error::invalid("step does not match the session epoch"));
            }
            state.seed.clone()
        };
        let prompt = compile(&seed, &action)?;
        let image_path = match &prompt.image {
            Some(image) => Some(self.verified_image(&image.file, &image.sha256)?),
            None => None,
        };
        let step_locator = locator(&session.id, action.epoch, action.sequence, CLIP_FILE);
        let step_dir = self
            .media_root
            .join(&session.id)
            .join(format!("e{}-s{}", action.epoch, action.sequence));
        if step_dir.exists() {
            return Err(Pan2Error::invalid("this step was already rendered"));
        }
        tokio::fs::create_dir_all(&step_dir).await?;
        tokio::fs::write(step_dir.join(CAPTION_FILE), prompt.prompt.as_bytes()).await?;

        let job = RenderJob {
            prompt,
            generation_seed: seed.generation_seed,
            step_dir: step_dir.clone(),
            image_path,
        };
        // One clip at a time: a single GPU holds the whole model.
        let stats = {
            let _gpu = self.render_lock.lock().await;
            self.renderer.render(&job).await?
        };
        tokio::fs::write(
            step_dir.join(GENERATION_FILE),
            serde_json::to_vec_pretty(&stats)?,
        )
        .await?;

        let mut frames = Vec::with_capacity(3);
        for (file, media_type) in [
            (CLIP_FILE, "video/mp4"),
            (CAPTION_FILE, "application/json"),
            (GENERATION_FILE, "application/json"),
        ] {
            frames.push(describe(&step_dir, &step_locator, file, media_type)?);
        }
        let identity = self.renderer.identity();
        let chunk = SimulatedFrameChunk {
            frames,
            provenance: ModelProvenance {
                provider: "pan2-worker".into(),
                model: identity.model,
                checkpoint: identity.checkpoint,
                runtime_version: identity.runtime_version,
                source_snapshot_hash: seed.source_snapshot_hash.clone(),
                source_stream_epoch: seed.source_stream_epoch,
                prompt_action_hash: format!("sha256:{}", job.prompt.prompt_sha256),
                generation_seed: seed.generation_seed,
                generation_sequence: action.sequence,
                simulated: true,
                // A rollout is a prediction, never evidence about the space.
                confidence: 0.0,
                privacy: seed.privacy.clone(),
                license: ExternalModelKind::Pan2.license_policy(),
            },
        };
        Ok(SidecarResponse::Stepped {
            epoch: action.epoch,
            sequence: action.sequence,
            chunk: Box::new(chunk),
        })
    }

    fn verified_image(&self, file: &str, sha256: &str) -> Result<PathBuf, Pan2Error> {
        let path = self.image_root.join(file);
        let (actual, _) = sha256_file(&path).map_err(|error| Pan2Error::MediaMismatch {
            file: file.to_owned(),
            reason: format!("conditioning image is not on the worker: {error}"),
        })?;
        if actual != sha256 {
            return Err(Pan2Error::MediaMismatch {
                file: file.to_owned(),
                reason: "conditioning image does not match the hash in the seed".into(),
            });
        }
        Ok(path)
    }
}

fn describe(
    step_dir: &Path,
    clip_locator: &str,
    file: &str,
    media_type: &str,
) -> Result<FrameDescriptor, Pan2Error> {
    let (sha256, byte_length) = sha256_file(&step_dir.join(file))
        .map_err(|error| Pan2Error::Renderer(format!("renderer left no `{file}`: {error}")))?;
    if byte_length == 0 {
        return Err(Pan2Error::Renderer(format!(
            "renderer wrote an empty `{file}`"
        )));
    }
    let base = clip_locator
        .rsplit_once('/')
        .map(|(base, _)| base)
        .unwrap_or(clip_locator);
    Ok(FrameDescriptor {
        transport: MEDIA_TRANSPORT.into(),
        locator: format!("{base}/{file}"),
        content_hash: format!("sha256:{sha256}"),
        byte_length,
        media_type: media_type.into(),
    })
}

/// Serves the control protocol on a Unix socket until `shutdown` resolves.
///
/// Each connection carries exactly one request line and one response line.
pub async fn serve<R, F>(
    worker: Arc<Worker<R>>,
    socket_path: &Path,
    shutdown: F,
) -> Result<(), Pan2Error>
where
    R: Renderer + 'static,
    F: Future<Output = ()>,
{
    if socket_path.exists() {
        std::fs::remove_file(socket_path)?;
    }
    let listener = UnixListener::bind(socket_path)?;
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            () = &mut shutdown => break,
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let worker = Arc::clone(&worker);
                tokio::spawn(async move {
                    // A broken connection only affects that one request.
                    let _ = connection(worker, stream).await;
                });
            }
        }
    }
    let _ = std::fs::remove_file(socket_path);
    Ok(())
}

async fn connection<R: Renderer>(
    worker: Arc<Worker<R>>,
    stream: UnixStream,
) -> Result<(), Pan2Error> {
    let (reader, mut writer) = stream.into_split();
    let mut limited = BufReader::new(reader).take((MAX_SIDECAR_CONTROL_BYTES + 1) as u64);
    let mut line = Vec::new();
    limited.read_until(b'\n', &mut line).await?;
    let response = if line.len() > MAX_SIDECAR_CONTROL_BYTES {
        SidecarResponse::Error {
            message: "request exceeds the control-message limit".into(),
        }
    } else {
        match serde_json::from_slice::<SidecarControlRequest>(&line) {
            Ok(request) if request.schema_version == 1 => worker.handle(request.request).await,
            Ok(request) => SidecarResponse::Error {
                message: format!("unsupported schema version {}", request.schema_version),
            },
            Err(error) => SidecarResponse::Error {
                message: format!("malformed request: {error}"),
            },
        }
    };
    let mut payload = serde_json::to_vec(&SidecarControlResponse {
        schema_version: 1,
        response,
    })?;
    payload.push(b'\n');
    writer.write_all(&payload).await?;
    writer.flush().await?;
    Ok(())
}
