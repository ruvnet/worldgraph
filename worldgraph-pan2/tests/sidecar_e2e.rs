//! End-to-end over a real Unix socket: plan → ADR-204 provider → pan2 worker →
//! verified bundle → graph record → Spaces event. Only the renderer is faked.

mod common;

use std::time::Duration;

use wifi_densepose_worldgraph::{WorldGraph, WorldNode};
use wifi_densepose_worldmodel::{GenerativeWorldModel, WorldModelError};
use worldgraph_pan2::bundle::read_bundle;
use worldgraph_pan2::compile::ImageRef;
use worldgraph_pan2::media::sha256_hex;
use worldgraph_pan2::pipeline::{accept, generate, pan2_provider, WorkerPlacement};
use worldgraph_pan2::spaces::{rollout_event, validate_event, EventIdentity, SpacesTarget};
use worldgraph_pan2::Pan2Error;

use common::{door_plan, start, temp_dir};

fn hosted(socket: &std::path::Path) -> impl GenerativeWorldModel {
    pan2_provider(
        socket,
        Duration::from_secs(10),
        WorkerPlacement::Hosted,
        true,
    )
    .unwrap()
}

#[tokio::test]
async fn plan_becomes_a_verified_bundle_a_graph_record_and_a_spaces_event() {
    let harness = start("happy", false).await;
    let provider = hosted(&harness.socket);
    let plan = door_plan();
    let generated = generate(&provider, &plan).await.unwrap();

    let provenance = &generated.envelope.chunk.provenance;
    assert!(provenance.simulated);
    assert_eq!(provenance.confidence, 0.0);
    assert_eq!(provenance.provider, "pan2-worker");
    assert_eq!(provenance.license.license_id, "Apache-2.0");
    assert_eq!(provenance.generation_seed, 123);
    assert_eq!(provenance.source_snapshot_hash, "sha256:feedface");
    assert!(provenance.privacy.hosted_processing_approved);
    assert_eq!(generated.envelope.chunk.frames.len(), 3);
    assert!(generated.envelope.session_id.starts_with("pan2-t-"));

    let out = temp_dir("bundle");
    let mut graph = WorldGraph::new(Default::default());
    let recorded = accept(
        &generated,
        &plan,
        &harness.media_root,
        &out,
        None,
        &mut graph,
        &[],
        1_700_000_000_000,
    )
    .unwrap();

    // The bundle on disk re-verifies and names the same clip as the envelope.
    let reread = read_bundle(&out).unwrap();
    assert_eq!(reread, recorded.manifest);
    assert_eq!(reread.name, "RF door opens");
    assert!(reread.simulated);
    assert_eq!(reread.media.duration_sec, 5.0);
    assert_eq!(reread.generation.as_ref().unwrap().steps, Some(50));
    // The caption file is byte-identical to what the client compiled.
    let caption = std::fs::read(out.join("caption.json")).unwrap();
    assert_eq!(sha256_hex(&caption), generated.prompt.prompt_sha256);
    assert_eq!(reread.caption.sha256, generated.prompt.prompt_sha256);

    // Exactly one node was added: a zero-confidence SemanticState.
    assert_eq!(graph.node_count(), 1);
    match graph.node(recorded.state_id).unwrap() {
        WorldNode::SemanticState {
            statement,
            confidence,
            provenance,
            ..
        } => {
            assert!(statement.starts_with("SIMULATED rollout"));
            assert_eq!(*confidence, 0.0);
            assert!(provenance.evidence[0].starts_with("sha256:"));
            assert!(provenance.model_version.contains("seed 123"));
            assert!(provenance
                .privacy_decision
                .contains("hosted_processing_approved=true"));
        }
        other => panic!("unexpected node {other:?}"),
    }

    let event = rollout_event(
        &generated.envelope,
        &SpacesTarget {
            site_id: "rulab".into(),
            space_id: "main-lab".into(),
        },
        &EventIdentity {
            id: "rollout:1".into(),
            message_id: "rollout-msg:1".into(),
            event_sequence: 1,
            observed_at: "2026-11-11T10:00:00Z".into(),
        },
        Some("https://example.invalid/rollouts/rf-door/clip.mp4"),
    )
    .unwrap();
    validate_event(&event).unwrap();
    assert_eq!(event["eventType"], "simulation.rollout");
    assert_eq!(event["confidence"], 0);
    assert_eq!(event["attributes"]["simulated"], true);
    assert_eq!(event["attributes"]["mediaSha256"], reread.media.sha256);
    assert_eq!(event["provenance"]["generationSeed"], "123");
    assert!(serde_json::to_vec(&event).unwrap().len() < 4_096);
    std::fs::remove_dir_all(out).unwrap();
}

#[tokio::test]
async fn tampered_media_is_rejected_and_the_graph_stays_empty() {
    let harness = start("tamper", false).await;
    let plan = door_plan();
    let generated = generate(&hosted(&harness.socket), &plan).await.unwrap();
    let clip = harness
        .media_root
        .join(&generated.envelope.session_id)
        .join("e0-s0")
        .join("clip.mp4");
    let mut bytes = std::fs::read(&clip).unwrap();
    bytes[0] ^= 0xff;
    std::fs::write(&clip, bytes).unwrap();

    let out = temp_dir("tamper-out");
    let mut graph = WorldGraph::new(Default::default());
    let error = accept(
        &generated,
        &plan,
        &harness.media_root,
        &out,
        None,
        &mut graph,
        &[],
        0,
    )
    .unwrap_err();
    assert!(matches!(error, Pan2Error::MediaMismatch { .. }), "{error}");
    assert_eq!(graph.node_count(), 0);
    assert!(!out.join("rollout.json").exists());
    let _ = std::fs::remove_dir_all(out);
}

#[tokio::test]
async fn a_different_caption_than_the_client_compiled_is_rejected() {
    let harness = start("caption", false).await;
    let plan = door_plan();
    let generated = generate(&hosted(&harness.socket), &plan).await.unwrap();
    // Pretend the caller accepts with a plan that differs from what was sent.
    let mut other = door_plan();
    other.actions[0].action = "slides sideways.".into();
    let (seed, action) = other.into_inputs(0, 0).unwrap();
    let mismatched = worldgraph_pan2::pipeline::Generated {
        prompt: worldgraph_pan2::compile::compile(&seed, &action).unwrap(),
        envelope: generated.envelope.clone(),
    };
    let out = temp_dir("caption-out");
    let mut graph = WorldGraph::new(Default::default());
    let error = accept(
        &mismatched,
        &other,
        &harness.media_root,
        &out,
        None,
        &mut graph,
        &[],
        0,
    )
    .unwrap_err();
    assert!(matches!(error, Pan2Error::Contract(_)), "{error}");
    assert_eq!(graph.node_count(), 0);
    let _ = std::fs::remove_dir_all(out);
}

#[tokio::test]
async fn a_hosted_worker_refuses_a_plan_without_processing_approval() {
    let harness = start("approval", false).await;
    let mut plan = door_plan();
    plan.hosted_processing_approved = false;
    let error = generate(&hosted(&harness.socket), &plan).await.unwrap_err();
    assert!(
        matches!(
            error,
            Pan2Error::WorldModel(WorldModelError::InvalidInput(_))
        ),
        "{error}"
    );
    // Nothing was rendered: the refusal happens before the socket is used.
    assert!(
        !harness.media_root.exists()
            || std::fs::read_dir(&harness.media_root)
                .unwrap()
                .next()
                .is_none()
    );
}

#[tokio::test]
async fn placement_and_terms_are_fail_closed() {
    let socket = std::path::Path::new("/nonexistent/pan2.sock");
    let timeout = Duration::from_secs(1);
    // Terms not accepted.
    assert!(pan2_provider(socket, timeout, WorkerPlacement::Hosted, false).is_err());
    // A local worker needs weights that exist.
    let missing = WorkerPlacement::Local {
        weights_path: "/nonexistent/weights".into(),
    };
    assert!(pan2_provider(socket, timeout, missing, true).is_err());
    let present = WorkerPlacement::Local {
        weights_path: std::env::temp_dir(),
    };
    assert!(pan2_provider(socket, timeout, present, true).is_ok());
}

#[tokio::test]
async fn image_to_video_requires_the_exact_image_on_the_worker() {
    let harness = start("image", false).await;
    let image = b"\x89PNG fixture bytes".to_vec();
    let local = temp_dir("image-local").join("first.png");
    std::fs::write(&local, &image).unwrap();
    let mut plan = door_plan();
    plan.image = Some(ImageRef {
        file: "first.png".into(),
        sha256: sha256_hex(&image),
    });
    let provider = hosted(&harness.socket);

    // Not uploaded yet: the worker refuses rather than falling back to text-to-video.
    let error = generate(&provider, &plan).await.unwrap_err().to_string();
    assert!(error.contains("conditioning image"), "{error}");

    // Wrong bytes under the right name are refused too.
    std::fs::write(harness.image_root.join("first.png"), b"other bytes").unwrap();
    let error = generate(&provider, &plan).await.unwrap_err().to_string();
    assert!(error.contains("does not match"), "{error}");

    std::fs::write(harness.image_root.join("first.png"), &image).unwrap();
    let generated = generate(&provider, &plan).await.unwrap();
    let out = temp_dir("image-out");
    let mut graph = WorldGraph::new(Default::default());
    let recorded = accept(
        &generated,
        &plan,
        &harness.media_root,
        &out,
        Some(&local),
        &mut graph,
        &[],
        0,
    )
    .unwrap();
    let first = recorded.manifest.first_frame.as_ref().unwrap();
    assert_eq!(first.file, "first.png");
    assert_eq!(first.sha256, sha256_hex(&image));
    assert!(
        String::from_utf8(std::fs::read(out.join("clip.mp4")).unwrap())
            .unwrap()
            .ends_with("image=true")
    );
    let _ = std::fs::remove_dir_all(out);
    let _ = std::fs::remove_dir_all(local.parent().unwrap());
}

#[tokio::test]
async fn renderer_failure_surfaces_as_a_provider_error_and_sessions_follow_epochs() {
    let failing = start("fail", true).await;
    let error = generate(&hosted(&failing.socket), &door_plan())
        .await
        .unwrap_err();
    assert!(
        matches!(&error, Pan2Error::WorldModel(WorldModelError::Provider(message)) if message.contains("fixture failure")),
        "{error}"
    );

    // Session rules: a second step in the same epoch works, a repeat is refused
    // by the Rust-owned sequence check, and reset moves to the next epoch.
    let harness = start("epochs", false).await;
    let provider = hosted(&harness.socket);
    let plan = door_plan();
    let (seed, first) = plan.into_inputs(0, 0).unwrap();
    let mut session = provider.initialize(seed.clone()).await.unwrap();
    provider.step(&mut session, first.clone()).await.unwrap();
    assert!(matches!(
        provider.step(&mut session, first).await,
        Err(WorldModelError::DuplicateSequence { .. })
    ));
    let (_, second) = plan.into_inputs(0, 1).unwrap();
    let chunk = provider.step(&mut session, second).await.unwrap();
    assert!(chunk.frames[0].locator.contains("/e0-s1/"));
    provider.reset(&mut session, seed).await.unwrap();
    assert_eq!((session.epoch, session.next_sequence), (1, 0));
    let (_, after_reset) = plan.into_inputs(1, 0).unwrap();
    let chunk = provider.step(&mut session, after_reset).await.unwrap();
    assert!(chunk.frames[0].locator.contains("/e1-s0/"));
    provider.finish(session).await.unwrap();
}
