//! PAN2-derived physical hypotheses. Predictions never update measured tracks.
//!
//! A separately deployed PAN2 worker and calibrated extractor produce the wire
//! response. This module does not infer metric positions from video pixels.
use crate::{ExternalModelConfig, ExternalModelKind, SidecarConfig, WorldModelError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};
use wifi_densepose_worldgraph::{SemanticProvenance, WorldGraph, WorldId, WorldNode};

type Result<T> = std::result::Result<T, WorldModelError>;
/// Maximum request or response size, including the newline delimiter.
pub const MAX_PHYSICAL_BYTES: usize = 256 * 1024;
fn require(ok: bool, message: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(WorldModelError::InvalidInput(message.into()))
    }
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn digest<T: Serialize>(v: &T) -> Result<String> {
    Ok(hash(&serde_json::to_vec(v)?))
}
fn sha(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn label(s: &str) -> bool {
    !s.trim().is_empty() && s.len() <= 128 && !s.chars().any(char::is_control)
}
fn distance2(a: [f64; 3], b: [f64; 3]) -> f64 {
    a.iter().zip(b).map(|(a, b)| (a - b).powi(2)).sum()
}

/// Axis-aligned closed box in a calibrated local ENU frame, in metres.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PhysicalBounds {
    /// Minimum east, north and up.
    pub min: [f64; 3],
    /// Maximum east, north and up.
    pub max: [f64; 3],
}
impl PhysicalBounds {
    fn valid(&self) -> bool {
        (0..3).all(|i| {
            self.min[i].is_finite()
                && self.max[i].is_finite()
                && self.min[i] < self.max[i]
                && self.min[i].abs() <= 1e6
                && self.max[i].abs() <= 1e6
        })
    }
    fn contains(&self, p: [f64; 3]) -> bool {
        (0..3).all(|i| p[i].is_finite() && p[i] >= self.min[i] && p[i] <= self.max[i])
    }
    // Segment/slab test catches tunnelling even when both endpoints are outside.
    fn intersects(&self, a: [f64; 3], b: [f64; 3]) -> bool {
        let (mut lo, mut hi) = (0.0f64, 1.0f64);
        for i in 0..3 {
            let d = b[i] - a[i];
            if d == 0.0 {
                if a[i] < self.min[i] || a[i] > self.max[i] {
                    return false;
                }
            } else {
                let x = (self.min[i] - a[i]) / d;
                let y = (self.max[i] - a[i]) / d;
                lo = lo.max(x.min(y));
                hi = hi.min(x.max(y));
                if lo > hi {
                    return false;
                }
            }
        }
        true
    }
}

/// Operator-authorized context and coarse physical constraints.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PhysicalContext {
    /// Stream epoch supplying the observed starting state.
    pub source_epoch: u64,
    /// Observation time in Unix milliseconds.
    pub observed_at_ms: i64,
    /// Stable metric coordinate-frame identifier.
    pub frame_id: String,
    /// Calibration version used by both scene and extractor.
    pub calibration_id: String,
    /// Bounded text action to simulate.
    pub action: String,
    /// Forecast horizon, from 1 to 20,000 milliseconds.
    pub horizon_ms: u32,
    /// Deterministic generation seed.
    pub generation_seed: u64,
    /// Permitted scene extent.
    pub bounds: PhysicalBounds,
    /// Authoritative occupied boxes; empty means no obstacle geometry supplied.
    pub obstacles: Vec<PhysicalBounds>,
    /// Conservative speed ceiling in metres per second, up to 100.
    pub max_speed_mps: f64,
    /// Caller-applied privacy projection, before model invocation.
    pub privacy: crate::PrivacyDecision,
}
impl PhysicalContext {
    fn validate(&self) -> Result<()> {
        require(
            label(&self.frame_id)
                && label(&self.calibration_id)
                && label(&self.privacy.projection_id),
            "frame, calibration and privacy projection are required",
        )?;
        require(
            !self.action.trim().is_empty() && self.action.len() <= 2048,
            "action must contain 1..=2048 bytes",
        )?;
        require(
            self.horizon_ms > 0
                && self.horizon_ms <= 20_000
                && self.observed_at_ms >= 0
                && self
                    .observed_at_ms
                    .checked_add(self.horizon_ms as i64)
                    .is_some(),
            "invalid forecast time range",
        )?;
        require(
            self.bounds.valid()
                && self.obstacles.len() <= 128
                && self.obstacles.iter().all(PhysicalBounds::valid),
            "invalid or oversized physical bounds",
        )?;
        require(
            self.max_speed_mps.is_finite()
                && self.max_speed_mps > 0.0
                && self.max_speed_mps <= 100.0,
            "invalid speed ceiling",
        )
    }
}
/// An explicitly selected observed track. No embeddings, names or raw frames.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PhysicalTrackSeed {
    /// Stable graph node identity within the authorized projection.
    pub world_id: WorldId,
    /// Tracker identifier within the authorized projection.
    pub track_id: u64,
    /// Last measured local ENU position.
    pub position_m: [f64; 3],
}
/// Versioned input accepted by a separately configured physical sidecar.
#[derive(Debug, Clone, Serialize)]
pub struct Pan2PhysicalRequest {
    /// Wire schema version, currently 1.
    pub schema_version: u16,
    /// Hash of the authorized projection only.
    pub projection_sha256: String,
    /// Bounded generation context.
    pub context: PhysicalContext,
    /// Selected observed starting positions, sorted by WorldId.
    pub tracks: Vec<PhysicalTrackSeed>,
}
/// Immutable prepared projection, bound locally to a specific graph snapshot.
#[derive(Debug, Clone)]
pub struct PreparedPhysicalScene {
    inner: Arc<PreparedPhysicalInner>,
}
#[derive(Debug)]
struct PreparedPhysicalInner {
    request: Pan2PhysicalRequest,
    graph_sha256: String,
    request_digest: String,
    wire: Vec<u8>,
    track_index: BTreeMap<u64, usize>,
}
impl PreparedPhysicalScene {
    /// Project only selected tracks. The caller must authorize IDs and context.
    pub fn from_graph(
        graph: &WorldGraph,
        ids: &[WorldId],
        context: PhysicalContext,
    ) -> Result<Self> {
        context.validate()?;
        require(!ids.is_empty() && ids.len() <= 64, "select 1..=64 tracks")?;
        let mut seen = BTreeSet::new();
        let mut tracker_ids = BTreeSet::new();
        let mut tracks = Vec::new();
        for id in ids {
            require(seen.insert(id.0), "duplicate graph track")?;
            match graph.node(*id) {
                Some(WorldNode::PersonTrack {
                    track_id,
                    last_position,
                    ..
                }) => {
                    require(tracker_ids.insert(*track_id), "duplicate tracker identity")?;
                    let p = [
                        last_position.east_m,
                        last_position.north_m,
                        last_position.up_m,
                    ];
                    require(
                        context.bounds.contains(p)
                            && !context.obstacles.iter().any(|b| b.contains(p)),
                        "observed track is outside permitted free space",
                    )?;
                    tracks.push(PhysicalTrackSeed {
                        world_id: *id,
                        track_id: *track_id,
                        position_m: p,
                    });
                }
                _ => {
                    return Err(WorldModelError::InvalidInput(
                        "selected node is not a person track".into(),
                    ))
                }
            }
        }
        tracks.sort_by_key(|t| t.world_id.0);
        let projection_sha256 = digest(&(&context, &tracks))?;
        let request = Pan2PhysicalRequest {
            schema_version: 1,
            projection_sha256,
            context,
            tracks,
        };
        let mut wire = serde_json::to_vec(&request)?;
        require(
            wire.len() < MAX_PHYSICAL_BYTES,
            "projection exceeds wire limit",
        )?;
        let request_digest = hash(&wire);
        wire.push(b'\n');
        let track_index = request
            .tracks
            .iter()
            .enumerate()
            .map(|(index, track)| (track.track_id, index))
            .collect();
        Ok(Self {
            inner: Arc::new(PreparedPhysicalInner {
                request,
                request_digest,
                wire,
                track_index,
                graph_sha256: hash(
                    &graph
                        .to_json()
                        .map_err(|e| WorldModelError::Protocol(e.to_string()))?,
                ),
            }),
        })
    }
    /// Read-only, privacy-projected model request.
    pub fn request(&self) -> &Pan2PhysicalRequest {
        &self.inner.request
    }
    /// Stable content hash binding a response to this exact request.
    pub fn request_sha256(&self) -> Result<String> {
        Ok(self.inner.request_digest.clone())
    }
    /// Validate untrusted extractor JSON before constructing a usable branch.
    pub fn accept_json(&self, bytes: &[u8]) -> Result<PhysicalForecastBranch> {
        require(
            bytes.len() <= MAX_PHYSICAL_BYTES,
            "physical response exceeds wire limit",
        )?;
        let r: Pan2PhysicalResponse = serde_json::from_slice(bytes)?;
        require(
            r.schema_version == 1 && r.request_sha256 == self.inner.request_digest,
            "response schema or request hash mismatch",
        )?;
        require(
            sha(&r.model_sha256) && sha(&r.artifact_sha256) && label(&r.extractor_version),
            "model, artifact and extractor provenance required",
        )?;
        let ctx = &self.inner.request.context;
        require(
            r.frame_id == ctx.frame_id && r.calibration_id == ctx.calibration_id,
            "unregistered prediction frame",
        )?;
        require(
            r.trajectories.len() == self.inner.request.tracks.len(),
            "response must cover exactly the selected tracks",
        )?;
        let mut seen = BTreeSet::new();
        for t in &r.trajectories {
            require(seen.insert(t.track_id), "duplicate predicted track")?;
            let index =
                self.inner.track_index.get(&t.track_id).ok_or_else(|| {
                    WorldModelError::InvalidInput("unknown predicted track".into())
                })?;
            let seed = &self.inner.request.tracks[*index];
            require(
                !t.points.is_empty() && t.points.len() <= 64,
                "trajectory requires 1..=64 points",
            )?;
            let (mut p, mut at) = (seed.position_m, 0);
            let (mut swept_min, mut swept_max) = (seed.position_m, seed.position_m);
            for next in &t.points {
                require(
                    next.offset_ms > at
                        && next.offset_ms <= ctx.horizon_ms
                        && ctx.bounds.contains(next.position_m),
                    "invalid trajectory time or position",
                )?;
                let speed =
                    distance2(p, next.position_m).sqrt() / ((next.offset_ms - at) as f64 / 1000.0);
                require(
                    speed <= ctx.max_speed_mps,
                    "trajectory exceeds speed ceiling",
                )?;
                for axis in 0..3 {
                    swept_min[axis] = swept_min[axis].min(next.position_m[axis]);
                    swept_max[axis] = swept_max[axis].max(next.position_m[axis]);
                }
                (p, at) = (next.position_m, next.offset_ms);
            }
            let nearby: Vec<_> = ctx
                .obstacles
                .iter()
                .filter(|b| {
                    (0..3).all(|axis| {
                        b.min[axis] <= swept_max[axis] && b.max[axis] >= swept_min[axis]
                    })
                })
                .collect();
            if !nearby.is_empty() {
                let mut previous = seed.position_m;
                for next in &t.points {
                    require(
                        !nearby
                            .iter()
                            .any(|b| b.intersects(previous, next.position_m)),
                        "trajectory intersects authoritative obstacle",
                    )?;
                    previous = next.position_m;
                }
            }
        }
        Ok(PhysicalForecastBranch {
            scene: self.clone(),
            response: r,
        })
    }
}
/// Separates real provider claims from deterministic protocol fixtures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PhysicalExecution {
    /// Separately deployed model plus calibrated extraction; caller asserted.
    Pan2,
    /// Protocol fixture. Never evidence of PAN2 execution or model quality.
    Fixture,
}
/// One predicted future position in calibrated ENU metres.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PhysicalPoint {
    /// Time since the source observation.
    pub offset_ms: u32,
    /// East, north, up coordinates.
    pub position_m: [f64; 3],
}
/// Hypothesized trajectory for one selected tracker identity.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PhysicalTrajectory {
    /// Track identity, matching the authorized projection.
    pub track_id: u64,
    /// Strictly ordered future points.
    pub points: Vec<PhysicalPoint>,
}
/// Untrusted response from a PAN2 metric extractor, not raw model state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pan2PhysicalResponse {
    /// Wire schema, currently 1.
    pub schema_version: u16,
    /// Exact JSON request digest.
    pub request_sha256: String,
    /// Checkpoint or complete model manifest digest supplied by executor.
    pub model_sha256: String,
    /// Generated artifact or latent-bundle digest supplied by executor.
    pub artifact_sha256: String,
    /// Metric extraction implementation/version.
    pub extractor_version: String,
    /// Must equal the request's metric frame.
    pub frame_id: String,
    /// Must equal the request's calibration version.
    pub calibration_id: String,
    /// Declared execution mode; hashes are not execution attestations.
    pub execution: PhysicalExecution,
    /// All requested tracks, exactly once.
    pub trajectories: Vec<PhysicalTrajectory>,
}
/// Validated, separate prediction branch. No API mutates the observed graph.
#[derive(Debug, Clone)]
pub struct PhysicalForecastBranch {
    scene: PreparedPhysicalScene,
    response: Pan2PhysicalResponse,
}
#[derive(Serialize)]
struct HypothesisStatement<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    execution: PhysicalExecution,
    trajectory: &'a PhysicalTrajectory,
    request_sha256: &'a str,
    not_observed: bool,
}
impl PhysicalForecastBranch {
    /// Validated response and explicit execution classification.
    pub fn response(&self) -> &Pan2PhysicalResponse {
        &self.response
    }
    /// Materialize hypotheses into a COPY of the original graph.
    pub fn hypothesis_graph(&self, observed: &WorldGraph) -> Result<WorldGraph> {
        let bytes = observed
            .to_json()
            .map_err(|e| WorldModelError::Protocol(e.to_string()))?;
        require(
            hash(&bytes) == self.scene.inner.graph_sha256,
            "observed graph changed; reproject before branching",
        )?;
        let mut branch =
            WorldGraph::from_json(&bytes).map_err(|e| WorldModelError::Protocol(e.to_string()))?;
        for trajectory in &self.response.trajectories {
            let source = &self.scene.inner.request.tracks
                [self.scene.inner.track_index[&trajectory.track_id]];
            let statement = serde_json::to_string(&HypothesisStatement {
                kind: "physical_hypothesis",
                execution: self.response.execution,
                trajectory,
                request_sha256: &self.response.request_sha256,
                not_observed: true,
            })?;
            branch.add_semantic_state(
                statement,
                0.0,
                self.scene.inner.request.context.observed_at_ms,
                SemanticProvenance {
                    evidence: vec![
                        self.response.artifact_sha256.clone(),
                        self.response.request_sha256.clone(),
                    ],
                    model_version: format!(
                        "PAN2:{};extractor:{}",
                        self.response.model_sha256, self.response.extractor_version
                    ),
                    calibration_version: self.response.calibration_id.clone(),
                    privacy_decision: self
                        .scene
                        .inner
                        .request
                        .context
                        .privacy
                        .projection_id
                        .clone(),
                },
                &[source.world_id],
            );
        }
        Ok(branch)
    }
    /// Compare exact future ticks against later measurements and a stationary baseline.
    /// Missing, extra or repeated ticks reject rather than biasing the score.
    pub fn reconcile(&self, observations: &PhysicalObservations) -> Result<PhysicalScore> {
        let ctx = &self.scene.inner.request.context;
        require(
            observations.request_sha256 == self.response.request_sha256
                && observations.frame_id == ctx.frame_id
                && observations.calibration_id == ctx.calibration_id
                && observations.observed_at_ms == ctx.observed_at_ms,
            "observation context mismatch",
        )?;
        let expected: usize = self
            .response
            .trajectories
            .iter()
            .map(|t| t.points.len())
            .sum();
        require(
            observations.samples.len() == expected,
            "incomplete observation set",
        )?;
        let mut actual: Vec<_> = observations.samples.iter().collect();
        actual.sort_unstable_by_key(|o| (o.track_id, o.offset_ms));
        require(
            actual
                .windows(2)
                .all(|w| (w[0].track_id, w[0].offset_ms) != (w[1].track_id, w[1].offset_ms)),
            "duplicate observation tick",
        )?;
        for o in &observations.samples {
            require(
                o.position_m.iter().all(|v| v.is_finite() && v.abs() <= 1e6),
                "duplicate or invalid observation",
            )?;
        }
        let (mut error, mut baseline) = (0.0, 0.0);
        for t in &self.response.trajectories {
            let seed = &self.scene.inner.request.tracks[self.scene.inner.track_index[&t.track_id]];
            for p in &t.points {
                let index = actual
                    .binary_search_by_key(&(t.track_id, p.offset_ms), |o| (o.track_id, o.offset_ms))
                    .map_err(|_| {
                        WorldModelError::InvalidInput("observation tick mismatch".into())
                    })?;
                let observed = actual[index].position_m;
                error += distance2(p.position_m, observed);
                baseline += distance2(seed.position_m, observed);
            }
        }
        Ok(PhysicalScore {
            samples: expected,
            forecast_rmse_m: (error / expected as f64).sqrt(),
            stationary_rmse_m: (baseline / expected as f64).sqrt(),
            execution: self.response.execution,
        })
    }
}
/// Later sensor observation, never a generated prediction.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PhysicalObservation {
    /// Tracker identity.
    pub track_id: u64,
    /// Measured offset since source observation.
    pub offset_ms: u32,
    /// Measured ENU position.
    pub position_m: [f64; 3],
}
/// Sensor batch with explicit time, frame and forecast alignment.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PhysicalObservations {
    /// Forecast request being evaluated.
    pub request_sha256: String,
    /// Metric frame used for measurements.
    pub frame_id: String,
    /// Measurement calibration version.
    pub calibration_id: String,
    /// Source observation time used by forecast offsets.
    pub observed_at_ms: i64,
    /// Exact matching ticks for every forecast point.
    pub samples: Vec<PhysicalObservation>,
}
/// Point-position errors; not a calibrated probability or physics certification.
#[derive(Debug, Clone, Serialize)]
pub struct PhysicalScore {
    /// Number of evaluated points.
    pub samples: usize,
    /// Euclidean position RMSE.
    pub forecast_rmse_m: f64,
    /// RMSE if every track remained at its last observed position.
    pub stationary_rmse_m: f64,
    /// Keeps fixture results distinct from provider execution claims.
    pub execution: PhysicalExecution,
}
/// Bounded local socket client for a separately deployed PAN2 metric worker.
pub struct Pan2PhysicalBridge {
    config: SidecarConfig,
}
impl Pan2PhysicalBridge {
    /// Validate provider admission without starting a model or downloading weights.
    pub fn new(config: SidecarConfig, model: &ExternalModelConfig) -> Result<Self> {
        require(
            model.kind == ExternalModelKind::Pan2,
            "physical bridge requires PAN2 model kind",
        )?;
        require(
            !config.timeout.is_zero() && config.timeout <= Duration::from_secs(7200),
            "physical timeout must be in (0,7200] seconds",
        )?;
        model.build_sidecar(config.clone())?;
        Ok(Self { config })
    }
    /// Send the authorized projection, validate the complete response, and return a branch.
    pub async fn predict(&self, scene: &PreparedPhysicalScene) -> Result<PhysicalForecastBranch> {
        tokio::select! {
            _=self.config.cancellation.cancelled()=>Err(WorldModelError::Cancelled),
            result=tokio::time::timeout(self.config.timeout,self.exchange(scene))=>result.map_err(|_|WorldModelError::Timeout{timeout_s:self.config.timeout.as_secs().max(1)})?
        }
    }
    #[cfg(unix)]
    async fn exchange(&self, scene: &PreparedPhysicalScene) -> Result<PhysicalForecastBranch> {
        use tokio::{
            io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
            net::UnixStream,
        };
        let stream = UnixStream::connect(&self.config.socket_path)
            .await
            .map_err(|source| WorldModelError::SocketConnect {
                path: self.config.socket_path.display().to_string(),
                source,
            })?;
        let (reader, mut writer) = stream.into_split();
        writer
            .write_all(&scene.inner.wire)
            .await
            .map_err(|e| WorldModelError::Protocol(e.to_string()))?;
        let mut limited = BufReader::new(reader).take((MAX_PHYSICAL_BYTES + 1) as u64);
        let mut bytes = Vec::new();
        limited
            .read_until(b'\n', &mut bytes)
            .await
            .map_err(|e| WorldModelError::Protocol(e.to_string()))?;
        require(
            bytes.last() == Some(&b'\n'),
            "unterminated physical response",
        )?;
        scene.accept_json(&bytes)
    }
    #[cfg(not(unix))]
    async fn exchange(&self, _scene: &PreparedPhysicalScene) -> Result<PhysicalForecastBranch> {
        Err(WorldModelError::Protocol(
            "PAN2 physical IPC requires Unix".into(),
        ))
    }
}
