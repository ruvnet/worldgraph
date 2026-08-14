//! Emits deterministic simulated-frame envelopes as newline-delimited JSON.
//!
//! This example needs no model weights, network service, or credentials. It
//! exercises initialize, ordered steps, reset/epoch rollover, and finish.

use std::collections::BTreeMap;

use wifi_densepose_worldmodel::{
    ActionChunk, ActionSample, GenerativeWorldModel, MockWorldModel, PrivacyDecision,
    RetentionPolicy, ScenePrimitive, SceneSeed,
};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let steps = std::env::args()
        .nth(1)
        .map(|value| value.parse::<u64>())
        .transpose()?
        .unwrap_or(4);
    if steps == 0 {
        return Err("step count must be greater than zero".into());
    }

    let provider = MockWorldModel::new();
    let mut session = provider.initialize(scene_seed(0)).await?;

    for index in 0..steps {
        if index == steps.div_ceil(2) {
            let next_source_epoch = session.epoch + 1;
            provider
                .reset(&mut session, scene_seed(next_source_epoch))
                .await?;
        }
        let sequence = session.next_sequence;
        let action = ActionChunk {
            epoch: session.epoch,
            sequence,
            samples: vec![ActionSample {
                offset_ms: 0,
                translation: [0.0, 0.0, 0.25 + index as f32 * 0.05],
                rotation: [0.0, index as f32 * 0.01, 0.0],
                controls: BTreeMap::from([("advance".into(), 1.0)]),
            }],
            action_hash: format!("demo-action-{index}"),
            metadata: BTreeMap::from([("source".into(), "deterministic-example".into())]),
        };
        let chunk = provider.step(&mut session, action).await?;
        let envelope = chunk.into_envelope(&session, sequence);
        println!("{}", serde_json::to_string(&envelope)?);
    }

    provider.finish(session).await?;
    Ok(())
}

fn scene_seed(epoch: u64) -> SceneSeed {
    SceneSeed {
        source_snapshot_hash: format!("sha256:deterministic-snapshot-{epoch}"),
        source_stream_epoch: epoch,
        generation_seed: 0x574f_524c_4447_5241,
        prompt: Some("render an explicitly simulated indoor future".into()),
        scene: vec![ScenePrimitive::Box {
            center_m: [0.0, 0.0, 1.0],
            size_m: [4.0, 4.0, 2.0],
            class: "anonymous_room".into(),
        }],
        privacy: PrivacyDecision {
            projection_id: "deterministic-public-fixture".into(),
            hosted_processing_approved: false,
            redactions_applied: 1,
            retention: RetentionPolicy::Ephemeral,
        },
        metadata: BTreeMap::from([("fixture".into(), "true".into())]),
    }
}
