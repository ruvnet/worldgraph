//! Shared fixtures: a renderer that needs no GPU and a worker on a temp socket.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::oneshot;
use wifi_densepose_worldmodel::ScenePrimitive;
use worldgraph_pan2::plan::{CameraKey, PlanAction, PlanEvent, PlanSubject, RolloutPlan};
use worldgraph_pan2::worker::{
    serve, RenderFuture, RenderJob, RenderStats, Renderer, RendererIdentity, Worker, CLIP_FILE,
};

static NEXT: AtomicU64 = AtomicU64::new(0);

/// A fresh empty directory under the system temp dir.
pub fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "wg-pan2-{label}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Writes bytes derived from the prompt hash and seed instead of running a model.
#[derive(Default)]
pub struct FakeRenderer {
    pub calls: AtomicU64,
    pub fail: bool,
}

impl Renderer for FakeRenderer {
    fn identity(&self) -> RendererIdentity {
        RendererIdentity {
            model: "test/fake-renderer".into(),
            checkpoint: "fixture-1".into(),
            runtime_version: "fixture".into(),
        }
    }

    fn render<'a>(&'a self, job: &'a RenderJob) -> RenderFuture<'a> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::Relaxed);
            if self.fail {
                return Err(worldgraph_pan2::Pan2Error::Renderer(
                    "fixture failure".into(),
                ));
            }
            let bytes = format!(
                "FAKE-CLIP {} seed={} frames={} image={}",
                job.prompt.prompt_sha256,
                job.generation_seed,
                job.prompt.frames,
                job.image_path.is_some()
            );
            std::fs::write(job.step_dir.join(CLIP_FILE), bytes)?;
            Ok(RenderStats {
                seconds: 0.1,
                steps: 50,
                hardware: Some("fixture".into()),
                peak_vram_gb: None,
            })
        })
    }
}

/// A running worker; dropping it stops the server.
pub struct Harness {
    pub root: PathBuf,
    pub socket: PathBuf,
    pub media_root: PathBuf,
    pub image_root: PathBuf,
    stop: Option<oneshot::Sender<()>>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Starts a worker with the fake renderer and waits for its socket.
pub async fn start(label: &str, fail: bool) -> Harness {
    let root = temp_dir(label);
    let socket = root.join("w.sock");
    let media_root = root.join("media");
    let image_root = root.join("images");
    std::fs::create_dir_all(&image_root).unwrap();
    let worker = Arc::new(
        Worker::new(
            FakeRenderer {
                calls: AtomicU64::new(0),
                fail,
            },
            &media_root,
            &image_root,
            "t",
        )
        .unwrap(),
    );
    let (stop, stopped) = oneshot::channel::<()>();
    let serving = Arc::clone(&worker);
    let path = socket.clone();
    tokio::spawn(async move {
        serve(serving, &path, async {
            let _ = stopped.await;
        })
        .await
        .unwrap();
    });
    for _ in 0..200 {
        if socket.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(Path::new(&socket).exists(), "worker socket did not appear");
    Harness {
        root,
        socket,
        media_root,
        image_root,
        stop: Some(stop),
    }
}

/// The RuLab RF-door scenario used across tests, examples and benches.
pub fn door_plan() -> RolloutPlan {
    RolloutPlan {
        name: "RF door opens".into(),
        source_snapshot_hash: "sha256:feedface".into(),
        source_stream_epoch: 7,
        generation_seed: 123,
        projection_id: "rulab-public-demo".into(),
        hosted_processing_approved: true,
        redactions_applied: 0,
        duration_sec: 5.0,
        first_frame: "A clean research lab with a closed grey shielded door in the far wall."
            .into(),
        scene: vec![
            ScenePrimitive::Box {
                center_m: [-2.0, 1.0, 0.5],
                size_m: [1.6, 0.9, 0.8],
                class: "workbench".into(),
            },
            ScenePrimitive::Box {
                center_m: [0.0, 4.0, 1.0],
                size_m: [1.0, 0.1, 2.0],
                class: "rf_door".into(),
            },
        ],
        style: None,
        lighting: None,
        view: None,
        subjects: vec![PlanSubject {
            name: "Shielded door".into(),
            attribute: "Grey steel RF door with a recessed handle.".into(),
        }],
        events: vec![
            PlanEvent {
                until_sec: 1.0,
                description: "The door stays closed while the view settles.".into(),
            },
            PlanEvent {
                until_sec: 5.0,
                description: "The door swings inward until it stands fully open.".into(),
            },
        ],
        actions: vec![PlanAction {
            from_sec: 1.0,
            to_sec: 4.5,
            subject: 1,
            action: "swings inward on its hinges until fully open.".into(),
        }],
        camera: vec![CameraKey {
            at_sec: 2.0,
            translation: [0.0, 0.4, 0.0],
            rotation: [0.0; 3],
            zoom: 0.0,
        }],
        image: None,
    }
}
