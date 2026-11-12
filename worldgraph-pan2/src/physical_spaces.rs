//! Cognitum Spaces <-> structured physical hypotheses (PR #18, ADR 207).
//!
//! Reads one *verified* snapshot (`GET /v1/spatial/snapshots/{spaceId}`, ADR-107) into the
//! request WorldGraph's physical validator needs, and turns a validated forecast into a labelled
//! zero-confidence Spaces simulation (`POST /v1/spatial/simulations`).
//!
//! Nothing here updates measured state: tracks come from the snapshot's anonymous entities, and
//! the forecast is only ever published as a `simulations` record, never as an event.
use crate::spaces::{validate_simulation, EventIdentity, SpacesTarget};
use crate::spaces_scene::{SpacesRecord, SpacesSnapshot};
use crate::Pan2Error;
use serde_json::{json, Value};
use wifi_densepose_worldgraph::{EnuPoint, WorldGraph, WorldId, WorldNode};
use wifi_densepose_worldmodel::physical::{
    PhysicalBounds, PhysicalContext, PhysicalForecastBranch, PreparedPhysicalScene,
};
use wifi_densepose_worldmodel::{PrivacyDecision, RetentionPolicy};

/// `simulationType` of a published forecast.
pub const HYPOTHESIS_SIMULATION_TYPE: &str = "physical.hypothesis";

/// Choices that are not in the Spaces data.
#[derive(Debug, Clone)]
pub struct HypothesisOptions {
    /// Stream epoch of the observed state.
    pub source_epoch: u64,
    /// Observation time, Unix milliseconds.
    pub observed_at_ms: i64,
    /// Bounded text action to simulate.
    pub action: String,
    /// Forecast horizon, 1 to 20,000 ms.
    pub horizon_ms: u32,
    /// Deterministic generation seed.
    pub generation_seed: u64,
    /// Speed ceiling used when the snapshot's zones declare none.
    pub default_max_speed_mps: f64,
    /// Whether sending this projection to a remote worker was approved.
    pub hosted_processing_approved: bool,
}

/// A graph, selected tracks and context built from one verified snapshot.
#[derive(Debug)]
pub struct SpacesPhysicalScene {
    /// Observed graph holding one anonymous `PersonTrack` per selected entity.
    pub graph: WorldGraph,
    /// The selected track nodes, in snapshot order.
    pub ids: Vec<WorldId>,
    /// Context for [`PreparedPhysicalScene::from_graph`].
    pub context: PhysicalContext,
    /// The verified `snapshotHash` the scene was built from.
    pub source_hash: String,
    /// Entities left out because they were not anonymous or had no placement.
    pub excluded: usize,
}

impl SpacesPhysicalScene {
    /// Projects the selected tracks for the physical sidecar.
    pub fn prepare(&self) -> Result<PreparedPhysicalScene, Pan2Error> {
        PreparedPhysicalScene::from_graph(&self.graph, &self.ids, self.context.clone())
            .map_err(|e| Pan2Error::Contract(e.to_string()))
    }
}

fn triple(record: &SpacesRecord, field: &str, key: &str) -> Option<[f64; 3]> {
    let values = record.other.get(field)?.get(key)?.as_array()?;
    if values.len() != 3 {
        return None;
    }
    let mut out = [0.0; 3];
    for (slot, value) in out.iter_mut().zip(values) {
        *slot = value.as_f64().filter(|v| v.is_finite())?;
    }
    Some(out)
}

fn bounds_of(record: &SpacesRecord) -> Option<PhysicalBounds> {
    let (c, s) = (
        triple(record, "placement", "centerM")?,
        triple(record, "placement", "sizeM")?,
    );
    Some(PhysicalBounds {
        min: [c[0] - s[0] / 2.0, c[1] - s[1] / 2.0, c[2] - s[2] / 2.0],
        max: [c[0] + s[0] / 2.0, c[1] + s[1] / 2.0, c[2] + s[2] / 2.0],
    })
}

/// Builds a physical scene from a snapshot whose hash the API response vouched for.
///
/// A snapshot read from a local file is refused: its hash was never checked against the server.
pub fn physical_scene_from_snapshot(
    snapshot: &SpacesSnapshot,
    options: &HypothesisOptions,
) -> Result<SpacesPhysicalScene, Pan2Error> {
    let source_hash = snapshot.source_hash.clone().ok_or_else(|| {
        Pan2Error::Contract(
            "a physical scene needs a snapshot read from the API (its snapshotHash is verified)"
                .into(),
        )
    })?;
    let bounds = bounds_of(&snapshot.space).ok_or_else(|| {
        Pan2Error::Contract("the space needs placement.centerM and placement.sizeM".into())
    })?;
    // Occupied space: solid objects with a placed footprint. Zones are areas, not obstacles.
    let obstacles: Vec<PhysicalBounds> = snapshot
        .entities
        .iter()
        .filter(|e| e.entity_type.as_deref() == Some("object"))
        .filter_map(bounds_of)
        .collect();
    // The most conservative speed limit any zone declares.
    let zone_limit = snapshot
        .zones
        .iter()
        .filter_map(|z| z.other.get("physics")?.get("maxSpeedMps")?.as_f64())
        .filter(|v| v.is_finite() && *v > 0.0)
        .fold(f64::INFINITY, f64::min);
    let max_speed_mps = if zone_limit.is_finite() {
        zone_limit
    } else {
        options.default_max_speed_mps
    };

    let mut people: Vec<&SpacesRecord> = snapshot
        .entities
        .iter()
        .filter(|e| matches!(e.entity_type.as_deref(), Some("person" | "track")))
        .collect();
    people.sort_by(|a, b| a.id.cmp(&b.id));
    let mut graph = WorldGraph::new(Default::default());
    let (mut ids, mut excluded) = (Vec::new(), 0usize);
    for record in people {
        let anonymous = record.identity_mode.as_deref() == Some("anonymous");
        let Some(c) = triple(record, "placement", "centerM").filter(|_| anonymous) else {
            excluded += 1;
            continue;
        };
        ids.push(graph.upsert_node(WorldNode::PersonTrack {
            id: WorldId::UNASSIGNED,
            track_id: ids.len() as u64 + 1,
            last_position: EnuPoint {
                east_m: c[0],
                north_m: c[1],
                up_m: c[2],
            },
            reid_embedding_ref: None,
        }));
    }
    if ids.is_empty() {
        return Err(Pan2Error::Contract(
            "the snapshot has no anonymous person or track entity with a placement".into(),
        ));
    }
    let context = PhysicalContext {
        source_epoch: options.source_epoch,
        observed_at_ms: options.observed_at_ms,
        frame_id: format!("{}:floor-local-m", snapshot.space.id),
        // Placement is writer-declared geometry, not a survey: say so in the calibration id.
        calibration_id: format!(
            "spaces-placement:{}",
            &source_hash[..source_hash.len().min(23)]
        ),
        action: options.action.clone(),
        horizon_ms: options.horizon_ms,
        generation_seed: options.generation_seed,
        bounds,
        obstacles,
        max_speed_mps,
        privacy: PrivacyDecision {
            projection_id: format!("spaces:{}", snapshot.space.id),
            hosted_processing_approved: options.hosted_processing_approved,
            redactions_applied: excluded as u32,
            retention: RetentionPolicy::Ephemeral,
        },
    };
    Ok(SpacesPhysicalScene {
        graph,
        ids,
        context,
        source_hash,
        excluded,
    })
}

/// Builds the `POST /v1/spatial/simulations` body for a validated forecast.
///
/// The record is labelled by the server (`simulated: true`, confidence 0). `execution` says whether
/// a contract fixture or a real PAN 2 extractor produced the trajectories, and the label says so too.
pub fn hypothesis_simulation(
    branch: &PhysicalForecastBranch,
    scene: &SpacesPhysicalScene,
    target: &SpacesTarget,
    identity: &EventIdentity,
) -> Result<Value, Pan2Error> {
    let response = branch.response();
    let execution = serde_json::to_value(response.execution)?;
    let fixture = execution.as_str() == Some("fixture");
    let trajectories: Vec<Value> = response
        .trajectories
        .iter()
        .map(|t| {
            json!({
                "trackId": t.track_id,
                // Objects, not nested arrays: Firestore cannot store an array inside an array.
                "points": t.points.iter().map(|p| json!({"offsetMs": p.offset_ms, "east": p.position_m[0], "north": p.position_m[1], "up": p.position_m[2]})).collect::<Vec<_>>(),
            })
        })
        .collect();
    let model = format!(
        "pan2/{}",
        &response.model_sha256[..response.model_sha256.len().min(16)]
    );
    let body = json!({
        "id": identity.id,
        "messageId": identity.message_id,
        "eventSequence": identity.event_sequence,
        "observedAt": identity.observed_at,
        "privacy": "P2",
        "siteId": target.site_id,
        "spaceId": target.space_id,
        "simulationType": HYPOTHESIS_SIMULATION_TYPE,
        "confidence": 0,
        "attributes": {
            "label": if fixture { "Contract fixture, not PAN 2 output and not an observation" }
                     else { "Model prediction, not an observation" },
            "execution": execution,
            "extractorVersion": response.extractor_version,
            "requestSha256": response.request_sha256,
            "artifactSha256": response.artifact_sha256,
            "modelSha256": response.model_sha256,
            "frameId": response.frame_id,
            "calibrationId": response.calibration_id,
            "horizonMs": scene.context.horizon_ms,
            "trajectories": trajectories,
        },
        "provenance": {
            "provider": format!("{} ({})", response.extractor_version, execution.as_str().unwrap_or("unknown")),
            "model": model,
            "generationSeed": scene.context.generation_seed.to_string(),
            "sourceSnapshotHash": scene.source_hash,
        },
    });
    validate_simulation(&body)?;
    Ok(body)
}
