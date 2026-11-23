//! ADR-210: fail-closed, read-only conditioning of a spatial scene.
//! A hash is a provenance receipt, not evidence that the scene is physically true.
use crate::WorldModelError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
/// Provenance origin distinct from sensor confidence.
pub enum Origin {
    /// Current authorized sensor stream.
    Live,
    /// Time-indexed recorded sensor stream.
    Replay,
    /// Authored or generated data, never current observation.
    Synthetic,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
/// Current scene or hypothetical future.
pub enum Purpose {
    /// Current scene with bounded freshness.
    CurrentView,
    /// Explicit future simulation.
    HypotheticalRollout,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
/// Epistemic status of a projected region.
pub enum Evidence {
    /// Aggregate occupancy with no position.
    CountOnly,
    /// Measured observation.
    Observed,
    /// Calibrated inference.
    Estimated,
    /// Map prior, not new sensing.
    MapPrior,
    /// Forecast, not current state.
    Predicted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
/// Source region with original timestamps.
pub struct Region {
    /// Anonymous identifier.
    pub id: String,
    /// Observation or inference class.
    pub evidence: Evidence,
    /// Aggregate count only.
    pub count: Option<u16>,
    /// Position in metres if justified.
    pub position_m: Option<[f32; 3]>,
    /// Source capture time.
    pub captured_at_ms: u64,
    /// Hard evidence expiry.
    pub valid_until_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
/// Bounded conditioning request from a separately verified snapshot.
pub struct Input {
    /// Authorized tenant scope.
    pub tenant: String,
    /// Authorized workspace scope.
    pub workspace: String,
    /// Authorized site scope.
    pub site: String,
    /// Authorized Space scope.
    pub space: String,
    /// Hash of separately verified snapshot.
    pub snapshot_hash: String,
    /// Sensor calibration revision.
    pub calibration: String,
    /// Policy revocation generation.
    pub privacy_epoch: u64,
    /// Stream ordering generation.
    pub stream_epoch: u64,
    /// Source capture time.
    pub captured_at_ms: u64,
    /// Hard evidence expiry.
    pub valid_until_ms: u64,
    /// Source provenance origin.
    pub origin: Origin,
    /// Rendering purpose.
    pub purpose: Purpose,
    /// Hosted processing admission.
    pub hosted_processing_approved: bool,
    /// Bounded list of projected regions.
    pub regions: Vec<Region>,
}
/// Established by the host's authorization policy, never by model inference.
pub struct Authority {
    /// Authorized tenant scope.
    pub tenant: String,
    /// Authorized workspace scope.
    pub workspace: String,
    /// Authorized site scope.
    pub site: String,
    /// Authorized Space scope.
    pub space: String,
    /// Sensor calibration revision.
    pub calibration: String,
    /// Policy revocation generation.
    pub privacy_epoch: u64,
    /// Server-authorized remote processing permission.
    pub hosted_allowed: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
/// Region safe for current visualization.
pub struct ProjectedRegion {
    /// Anonymous identifier.
    pub id: String,
    /// Observation or inference class.
    pub evidence: Evidence,
    /// Aggregate count only.
    pub count: Option<u16>,
    /// Position in metres if justified.
    pub position_m: Option<[f32; 3]>,
    /// Whether the position must be hidden.
    pub unknown: bool,
    /// Source capture time.
    pub captured_at_ms: u64,
    /// Hard evidence expiry.
    pub valid_until_ms: u64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
/// Versioned read-only rendering projection.
pub struct Manifest {
    /// Conditioning format version.
    pub schema: String,
    /// Authorized tenant scope.
    pub tenant: String,
    /// Authorized workspace scope.
    pub workspace: String,
    /// Authorized site scope.
    pub site: String,
    /// Authorized Space scope.
    pub space: String,
    /// Hash of separately verified snapshot.
    pub snapshot_hash: String,
    /// Sensor calibration revision.
    pub calibration: String,
    /// Policy revocation generation.
    pub privacy_epoch: u64,
    /// Stream ordering generation.
    pub stream_epoch: u64,
    /// Snapshot capture time.
    pub capture_ms: u64,
    /// Renderer presentation time.
    pub presentation_ms: u64,
    /// Source provenance origin.
    pub origin: Origin,
    /// Rendering purpose.
    pub purpose: Purpose,
    /// Hosted processing admission.
    pub hosted_processing_approved: bool,
    /// Bounded list of projected regions.
    pub regions: Vec<ProjectedRegion>,
    /// Projection digest, not proof of measurement.
    pub manifest_sha256: String,
}
fn invalid(why: &str) -> WorldModelError {
    WorldModelError::InvalidInput(why.to_string())
}
fn ident(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':'))
}
fn sha(s: &str) -> bool {
    s.len() == 71
        && s.starts_with("sha256:")
        && s[7..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
/// Deterministic, bounded projection at time now_ms. Caller must verify Spaces
/// snapshot bytes and hash separately before constructing Input.
pub fn compile(input: &Input, auth: &Authority, now_ms: u64) -> Result<Manifest, WorldModelError> {
    if input.tenant != auth.tenant
        || input.workspace != auth.workspace
        || input.site != auth.site
        || input.space != auth.space
    {
        return Err(invalid("foreign scope"));
    }
    if input.calibration != auth.calibration || input.privacy_epoch != auth.privacy_epoch {
        return Err(invalid("revoked privacy or changed calibration"));
    }
    if ![
        &input.tenant,
        &input.workspace,
        &input.site,
        &input.space,
        &input.calibration,
    ]
    .iter()
    .all(|s| ident(s))
        || !sha(&input.snapshot_hash)
    {
        return Err(invalid("invalid scope or source snapshot hash"));
    }
    if input.hosted_processing_approved && !auth.hosted_allowed {
        return Err(invalid("hosted processing not independently authorized"));
    }
    if input.purpose == Purpose::CurrentView && input.origin == Origin::Synthetic {
        return Err(invalid("synthetic data cannot be a live view"));
    }
    if input.captured_at_ms > now_ms
        || input.valid_until_ms < input.captured_at_ms
        || now_ms > input.valid_until_ms
    {
        return Err(invalid("expired source evidence"));
    }
    if input.regions.len() > 128 {
        return Err(invalid("too many regions"));
    }
    let mut ids = BTreeSet::new();
    let mut projected = Vec::new();
    for r in &input.regions {
        if !ident(&r.id) || !ids.insert(&r.id) {
            return Err(invalid("duplicate or invalid region"));
        }
        if r.captured_at_ms > now_ms || r.valid_until_ms < r.captured_at_ms {
            return Err(invalid("invalid region clock"));
        }
        if r.evidence == Evidence::CountOnly {
            if r.position_m.is_some() || r.count.unwrap_or(0) == 0 {
                return Err(invalid("count-only evidence cannot carry coordinates"));
            }
        } else if r.count.is_some() {
            return Err(invalid("count on positional region"));
        }
        if let Some(v) = r.position_m {
            if !v.iter().all(|x| x.is_finite() && x.abs() <= 100_000.0) {
                return Err(invalid("invalid metric coordinates"));
            }
        }
        let expired = now_ms > r.valid_until_ms;
        let hypothetical =
            r.evidence == Evidence::Predicted && input.purpose == Purpose::CurrentView;
        let unknown = expired
            || hypothetical
            || (r.evidence != Evidence::CountOnly && r.position_m.is_none());
        projected.push(ProjectedRegion {
            id: r.id.clone(),
            evidence: r.evidence,
            count: if expired { None } else { r.count },
            position_m: if unknown { None } else { r.position_m },
            unknown,
            captured_at_ms: r.captured_at_ms,
            valid_until_ms: r.valid_until_ms,
        });
    }
    let mut m = Manifest {
        schema: "cognitum.reality.conditioning.v1".into(),
        tenant: input.tenant.clone(),
        workspace: input.workspace.clone(),
        site: input.site.clone(),
        space: input.space.clone(),
        snapshot_hash: input.snapshot_hash.clone(),
        calibration: input.calibration.clone(),
        privacy_epoch: input.privacy_epoch,
        stream_epoch: input.stream_epoch,
        capture_ms: input.captured_at_ms,
        presentation_ms: now_ms,
        origin: input.origin,
        purpose: input.purpose,
        hosted_processing_approved: input.hosted_processing_approved,
        regions: projected,
        manifest_sha256: String::new(),
    };
    // Hash the JSON with the receipt field empty, preserving its serialized order.
    let body = serde_json::to_vec(&m).map_err(|_| invalid("serialize manifest"))?;
    m.manifest_sha256 = format!("sha256:{:x}", Sha256::digest(body));
    Ok(m)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> (Input, Authority) {
        let i = Input {
            tenant: "tenant".into(),
            workspace: "work".into(),
            site: "site".into(),
            space: "room".into(),
            snapshot_hash: format!("sha256:{}", "a".repeat(64)),
            calibration: "cal1".into(),
            privacy_epoch: 7,
            stream_epoch: 2,
            captured_at_ms: 1000,
            valid_until_ms: 1500,
            origin: Origin::Replay,
            purpose: Purpose::CurrentView,
            hosted_processing_approved: false,
            regions: vec![Region {
                id: "p1".into(),
                evidence: Evidence::Estimated,
                count: None,
                position_m: Some([1.0, 2.0, 0.0]),
                captured_at_ms: 1000,
                valid_until_ms: 1300,
            }],
        };
        let a = Authority {
            tenant: i.tenant.clone(),
            workspace: i.workspace.clone(),
            site: i.site.clone(),
            space: i.space.clone(),
            calibration: i.calibration.clone(),
            privacy_epoch: i.privacy_epoch,
            hosted_allowed: false,
        };
        (i, a)
    }
    #[test]
    fn deterministic() {
        let (i, a) = sample();
        let x = compile(&i, &a, 1100).unwrap();
        assert_eq!(x, compile(&i, &a, 1100).unwrap());
        assert!(sha(&x.manifest_sha256));
    }
    #[test]
    fn count_only_no_coords() {
        let (mut i, a) = sample();
        i.regions[0].evidence = Evidence::CountOnly;
        i.regions[0].position_m = None;
        i.regions[0].count = Some(3);
        assert_eq!(compile(&i, &a, 1100).unwrap().regions[0].position_m, None);
        i.regions[0].position_m = Some([1.0, 0.0, 0.0]);
        assert!(compile(&i, &a, 1100).is_err());
    }
    #[test]
    fn blackout() {
        let (i, a) = sample();
        assert!(compile(&i, &a, 1501).is_err());
    }
    #[test]
    fn expired_person_unknown() {
        let (i, a) = sample();
        let x = compile(&i, &a, 1400).unwrap();
        assert!(x.regions[0].unknown);
        assert_eq!(x.regions[0].position_m, None);
    }
    #[test]
    fn tenant_denial() {
        let (i, mut a) = sample();
        a.tenant = "other".into();
        assert!(compile(&i, &a, 1100).is_err());
    }
    #[test]
    fn privacy_denial() {
        let (i, mut a) = sample();
        a.privacy_epoch += 1;
        assert!(compile(&i, &a, 1100).is_err());
    }
    #[test]
    fn calibration_denial() {
        let (i, mut a) = sample();
        a.calibration = "new".into();
        assert!(compile(&i, &a, 1100).is_err());
    }
    #[test]
    fn hosted_denial() {
        let (mut i, a) = sample();
        i.hosted_processing_approved = true;
        assert!(compile(&i, &a, 1100).is_err());
    }
    #[test]
    fn synthetic_current_denial() {
        let (mut i, a) = sample();
        i.origin = Origin::Synthetic;
        assert!(compile(&i, &a, 1100).is_err());
    }
    #[test]
    fn generated_future_not_current() {
        let (mut i, a) = sample();
        i.regions[0].evidence = Evidence::Predicted;
        assert!(compile(&i, &a, 1100).unwrap().regions[0].unknown);
    }
    #[test]
    fn unauthorized_raw_fields() {
        let (i, _) = sample();
        let mut v = serde_json::to_value(i).unwrap();
        v["raw_csi"] = serde_json::json!([1, 2]);
        assert!(serde_json::from_value::<Input>(v).is_err());
    }
    #[test]
    fn duplicate_region_denial() {
        let (mut i, a) = sample();
        i.regions.push(i.regions[0].clone());
        assert!(compile(&i, &a, 1100).is_err());
    }
}
