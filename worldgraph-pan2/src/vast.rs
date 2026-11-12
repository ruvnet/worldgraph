//! Renderer that asks a Vast.ai serverless endpoint for each clip (ADR-210).
//!
//! The endpoint runs the PAN 2 generation server from `tools/pan2-vast` behind Vast's autoscaler. A request
//! first asks the autoscaler's router for a worker (polling while one starts), then posts the job to that
//! worker. The returned clip is checked against the hash the worker reports before it is written, so a
//! truncated or altered transfer cannot become a rollout.
//!
//! The renderer fails closed. It refuses any job the server's caps cannot honour (frame count, pixel count,
//! steps, seed range, image conditioning) instead of rendering something different from what was asked,
//! because the bundle built from the clip describes the requested clip. [`RenderStats::seconds`] is the
//! worker's own generation time; waiting for a cold worker is not model time and is not included.
//!
//! The account key is never logged, never put in an error, and is redacted from `Debug`.

use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::compile::Task;
use crate::media::sha256_hex;
use crate::worker::{RenderFuture, RenderJob, RenderStats, Renderer, RendererIdentity, CLIP_FILE};
use crate::Pan2Error;

/// Public Vast serverless router.
pub const DEFAULT_ROUTER: &str = "https://run.vast.ai";
/// Where Vast publishes the root certificate that signs worker addresses.
pub const ROOT_CERT_URL: &str = "https://console.vast.ai/static/jvastai_root.cer";
/// File written next to the clip with the worker's own description of how it was made.
pub const VAST_FILE: &str = "vast.json";
const MAX_PROMPT_BYTES: usize = 8192;
const MAX_ERROR_BODY: usize = 300;

/// What the server accepts. These mirror `pan2kit.serve --max-frames/--max-pixels/--max-steps`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caps {
    /// Most frames per clip.
    pub max_frames: u32,
    /// Most `height * width` pixels.
    pub max_pixels: u32,
    /// Most sampler steps.
    pub max_steps: u32,
}

impl Default for Caps {
    /// The smoke-test caps the server ships with.
    fn default() -> Self {
        Self {
            max_frames: 9,
            max_pixels: 256 * 448,
            max_steps: 4,
        }
    }
}

/// Connection and workload settings for one endpoint.
#[derive(Clone)]
pub struct VastConfig {
    /// Endpoint name, for example `pan2`.
    pub endpoint: String,
    api_key: String,
    /// Router base URL.
    pub router_url: String,
    /// PEM or DER bytes of Vast's root certificate, needed for `https` worker addresses.
    pub root_cert: Option<Vec<u8>>,
    /// Output height in pixels (multiple of 32).
    pub height: u32,
    /// Output width in pixels (multiple of 32).
    pub width: u32,
    /// Sampler steps.
    pub steps: u32,
    /// Limits the server enforces.
    pub caps: Caps,
    /// Longest total wait for a worker, cold start included.
    pub route_wait: Duration,
    /// Pause between router polls while a worker starts.
    pub poll: Duration,
    /// Longest wait for one generation once a worker is routed.
    pub request_timeout: Duration,
    /// If set, a response from a different PAN 2 commit is rejected.
    pub expect_pan_commit: Option<String>,
    /// Identity recorded in provenance.
    pub identity: RendererIdentity,
}

impl VastConfig {
    /// Smoke-size defaults (256x448, 4 steps) for `endpoint`, authenticated with `api_key`.
    pub fn new(
        endpoint: impl Into<String>,
        api_key: impl Into<String>,
        identity: RendererIdentity,
    ) -> Self {
        Self {
            endpoint: endpoint.into(),
            api_key: api_key.into(),
            router_url: DEFAULT_ROUTER.to_owned(),
            root_cert: None,
            height: 256,
            width: 448,
            steps: 4,
            caps: Caps::default(),
            route_wait: Duration::from_secs(40 * 60),
            poll: Duration::from_secs(15),
            request_timeout: Duration::from_secs(25 * 60),
            expect_pan_commit: None,
            identity,
        }
    }
}

impl std::fmt::Debug for VastConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VastConfig")
            .field("endpoint", &self.endpoint)
            .field("api_key", &"<redacted>")
            .field("router_url", &self.router_url)
            .field("height", &self.height)
            .field("width", &self.width)
            .field("steps", &self.steps)
            .field("caps", &self.caps)
            .finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
struct Generated {
    video_b64: String,
    sha256: String,
    seconds: f64,
    #[serde(default)]
    bytes: Option<u64>,
    #[serde(default)]
    gpu: Option<String>,
    #[serde(default)]
    pan_commit: Option<String>,
}

/// [`Renderer`] backed by a Vast.ai serverless endpoint.
pub struct VastRenderer {
    config: VastConfig,
    client: reqwest::Client,
}

impl VastRenderer {
    /// Builds the HTTP client. Nothing is requested until a job arrives.
    pub fn new(config: VastConfig) -> Result<Self, Pan2Error> {
        let mut builder = reqwest::Client::builder().use_rustls_tls();
        if let Some(bytes) = &config.root_cert {
            let cert = reqwest::Certificate::from_pem(bytes)
                .or_else(|_| reqwest::Certificate::from_der(bytes))
                .map_err(|_| Pan2Error::invalid("root certificate is neither PEM nor DER"))?;
            builder = builder.add_root_certificate(cert);
        }
        let client = builder.build().map_err(|error| {
            Pan2Error::Renderer(format!("cannot build the HTTP client: {error}"))
        })?;
        Ok(Self { config, client })
    }

    /// Refuses anything the server would render differently from what the job asks for.
    fn check(&self, job: &RenderJob) -> Result<(), Pan2Error> {
        let c = &self.config;
        let frames = job.prompt.frames;
        if job.prompt.task != Task::T2v || job.image_path.is_some() {
            return Err(Pan2Error::invalid(
                "the Vast endpoint serves text-to-video only",
            ));
        }
        if frames == 0 || !(frames - 1).is_multiple_of(8) || frames > c.caps.max_frames {
            return Err(Pan2Error::invalid(format!(
                "{frames} frames requested; the endpoint serves 8n+1 frames up to {}",
                c.caps.max_frames
            )));
        }
        if !c.height.is_multiple_of(32)
            || !c.width.is_multiple_of(32)
            || u64::from(c.height) * u64::from(c.width) > u64::from(c.caps.max_pixels)
        {
            return Err(Pan2Error::invalid(format!(
                "{}x{} is not a multiple of 32 within {} pixels",
                c.width, c.height, c.caps.max_pixels
            )));
        }
        if c.steps == 0 || c.steps > c.caps.max_steps {
            return Err(Pan2Error::invalid(format!(
                "{} steps; the endpoint allows 1 to {}",
                c.steps, c.caps.max_steps
            )));
        }
        if job.generation_seed > 0x7fff_ffff {
            return Err(Pan2Error::invalid(
                "generation seed exceeds the endpoint's 31-bit range",
            ));
        }
        if job.prompt.prompt.len() > MAX_PROMPT_BYTES {
            return Err(Pan2Error::invalid(
                "prompt exceeds the endpoint's 8192-byte limit",
            ));
        }
        Ok(())
    }

    /// Asks the router for a worker, polling while one starts. Returns the router's reply.
    async fn route(&self, cost: u32) -> Result<Value, Pan2Error> {
        let c = &self.config;
        let started = Instant::now();
        let mut index = 0_u64;
        loop {
            let body = json!({"endpoint": c.endpoint, "api_key": c.api_key, "cost": cost,
                              "request_idx": index, "replay_timeout": 60});
            let reply = self
                .client
                .post(format!("{}/route/", c.router_url.trim_end_matches('/')))
                .bearer_auth(&c.api_key)
                .timeout(Duration::from_secs(30))
                .json(&body)
                .send()
                .await;
            match reply {
                Ok(response) if response.status().is_success() => {
                    let value: Value = response
                        .json()
                        .await
                        .map_err(|_| Pan2Error::Renderer("router sent invalid JSON".into()))?;
                    if value.get("url").and_then(Value::as_str).is_some() {
                        return Ok(value);
                    }
                    index = value
                        .get("request_idx")
                        .and_then(Value::as_u64)
                        .unwrap_or(index);
                }
                Ok(response) if matches!(response.status().as_u16(), 400 | 401 | 403 | 404) => {
                    return Err(Pan2Error::Renderer(format!(
                        "router refused the request: HTTP {}",
                        response.status().as_u16()
                    )));
                }
                _ => {} // transient: retry until the wait budget is spent
            }
            if started.elapsed() > c.route_wait {
                return Err(Pan2Error::Renderer(format!(
                    "no worker became ready within {} s",
                    c.route_wait.as_secs()
                )));
            }
            tokio::time::sleep(c.poll).await;
        }
    }

    async fn run(&self, job: &RenderJob) -> Result<RenderStats, Pan2Error> {
        self.check(job)?;
        let c = &self.config;
        let route = self.route(job.prompt.frames).await?;
        let url = route["url"]
            .as_str()
            .unwrap_or_default()
            .trim_end_matches('/')
            .to_owned();
        let payload = json!({"prompt": job.prompt.prompt, "seed": job.generation_seed, "frames": job.prompt.frames,
                             "height": c.height, "width": c.width, "steps": c.steps});
        let response = self
            .client
            .post(format!("{url}/generate"))
            .bearer_auth(&c.api_key)
            .timeout(c.request_timeout)
            .json(&json!({"auth_data": route, "payload": payload}))
            .send()
            .await
            .map_err(|error| {
                Pan2Error::Renderer(format!("worker request failed: {}", error.without_url()))
            })?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|_| Pan2Error::Renderer("worker reply was cut off".into()))?;
        if !status.is_success() {
            let shown: String = text.chars().take(MAX_ERROR_BODY).collect();
            return Err(if status.as_u16() == 400 {
                Pan2Error::invalid(format!("worker rejected the job: {shown}"))
            } else {
                Pan2Error::Renderer(format!("worker returned HTTP {}: {shown}", status.as_u16()))
            });
        }
        let raw: Value = serde_json::from_str(&text)?;
        let generated: Generated = serde_json::from_value(raw.clone())?;
        if let (Some(expected), Some(actual)) = (&c.expect_pan_commit, &generated.pan_commit) {
            if expected != actual {
                return Err(Pan2Error::Renderer(format!(
                    "worker runs PAN 2 {actual}, expected {expected}"
                )));
            }
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(generated.video_b64.as_bytes())
            .map_err(|_| Pan2Error::MediaMismatch {
                file: CLIP_FILE.into(),
                reason: "clip is not valid base64".into(),
            })?;
        if bytes.is_empty()
            || generated.bytes.is_some_and(|n| n != bytes.len() as u64)
            || sha256_hex(&bytes) != generated.sha256
        {
            return Err(Pan2Error::MediaMismatch {
                file: CLIP_FILE.into(),
                reason: "clip does not match the hash the worker reported".into(),
            });
        }
        let clip = job.step_dir.join(CLIP_FILE);
        let partial = job.step_dir.join(format!("{CLIP_FILE}.part"));
        tokio::fs::write(&partial, &bytes).await?;
        tokio::fs::rename(&partial, &clip).await?;
        let mut note = raw;
        note.as_object_mut().map(|o| o.remove("video_b64"));
        tokio::fs::write(
            job.step_dir.join(VAST_FILE),
            serde_json::to_vec_pretty(&note)?,
        )
        .await?;
        Ok(RenderStats {
            seconds: (generated.seconds * 10.0).round() / 10.0,
            steps: c.steps,
            hardware: generated.gpu,
            peak_vram_gb: None,
        })
    }
}

impl Renderer for VastRenderer {
    fn identity(&self) -> RendererIdentity {
        self.config.identity.clone()
    }

    fn render<'a>(&'a self, job: &'a RenderJob) -> RenderFuture<'a> {
        Box::pin(self.run(job))
    }
}
