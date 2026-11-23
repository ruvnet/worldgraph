//! Export a deterministic, explicitly synthetic test manifest for API parity.
use wifi_densepose_worldmodel::conditioning::{
    compile, Authority, Evidence, Input, Origin, Purpose, Region,
};

fn main() {
    let input = Input {
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
        hosted_processing_approved: true,
        regions: vec![Region {
            id: "p1".into(),
            evidence: Evidence::Estimated,
            count: None,
            position_m: Some([1.0, 2.0, 0.0]),
            captured_at_ms: 1000,
            valid_until_ms: 1400,
        }],
    };
    let auth = Authority {
        tenant: input.tenant.clone(),
        workspace: input.workspace.clone(),
        site: input.site.clone(),
        space: input.space.clone(),
        calibration: input.calibration.clone(),
        privacy_epoch: input.privacy_epoch,
        hosted_allowed: true,
    };
    let manifest = compile(&input, &auth, 1100).expect("valid illustrative input");
    println!(
        "{}",
        serde_json::to_string(&manifest).expect("serializable manifest")
    );
}
