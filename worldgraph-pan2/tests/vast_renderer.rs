//! ADR-210: the Vast serverless renderer against a stand-in router and worker. No network, no GPU.
#![cfg(feature = "vast")]

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use worldgraph_pan2::compile::compile;
use worldgraph_pan2::media::sha256_hex;
use worldgraph_pan2::vast::{VastConfig, VastRenderer, VAST_FILE};
use worldgraph_pan2::worker::{RenderJob, Renderer, RendererIdentity, CLIP_FILE};
use worldgraph_pan2::Pan2Error;

const KEY: &str = "test-account-key-0123456789";
type Seen = Arc<Mutex<Vec<(String, String, Value)>>>;
type Handler = Arc<dyn Fn(&str, &Value, usize) -> (u16, Value) + Send + Sync>;

/// Minimal HTTP/1.1 server: one request per connection, JSON in and out.
async fn stand_in(handler: Handler) -> (String, Seen) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen: Seen = Arc::default();
    let log = seen.clone();
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (handler, log) = (handler.clone(), log.clone());
            tokio::spawn(async move {
                let mut buffer = Vec::new();
                let (head_end, length) = loop {
                    let mut chunk = [0_u8; 4096];
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buffer.extend_from_slice(&chunk[..n]);
                    if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buffer[..end]).to_lowercase();
                        let length = head
                            .lines()
                            .find_map(|l| {
                                l.strip_prefix("content-length: ")?
                                    .trim()
                                    .parse::<usize>()
                                    .ok()
                            })
                            .unwrap_or(0);
                        break (end + 4, length);
                    }
                };
                while buffer.len() < head_end + length {
                    let mut chunk = [0_u8; 65536];
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buffer.extend_from_slice(&chunk[..n]);
                }
                let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
                let path = head.split_whitespace().nth(1).unwrap_or("").to_owned();
                let auth = head
                    .lines()
                    .find(|l| l.to_lowercase().starts_with("authorization:"))
                    .unwrap_or("")
                    .to_owned();
                let body: Value =
                    serde_json::from_slice(&buffer[head_end..]).unwrap_or(Value::Null);
                let count = {
                    let mut seen = log.lock().unwrap();
                    seen.push((path.clone(), auth, body.clone()));
                    seen.iter().filter(|(p, ..)| *p == path).count()
                };
                let (code, reply) = handler(&path, &body, count);
                let text = reply.to_string();
                let out = format!("HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len());
                let _ = socket.write_all(out.as_bytes()).await;
            });
        }
    });
    (base, seen)
}

fn identity() -> RendererIdentity {
    RendererIdentity {
        model: "IFM/PAN2".into(),
        checkpoint: "rev".into(),
        runtime_version: "commit".into(),
    }
}

fn job(label: &str, frames: u32) -> RenderJob {
    let (seed, action) = common::door_plan().into_inputs(0, 0).unwrap();
    let mut prompt = compile(&seed, &action).unwrap();
    prompt.frames = frames;
    let step_dir = common::temp_dir(label);
    std::fs::create_dir_all(&step_dir).unwrap();
    RenderJob {
        prompt,
        generation_seed: 42,
        step_dir,
        image_path: None,
    }
}

fn config(router: &str) -> VastConfig {
    let mut c = VastConfig::new("pan2", KEY, identity());
    c.router_url = router.to_owned();
    c.poll = Duration::from_millis(20);
    c.route_wait = Duration::from_secs(5);
    c.request_timeout = Duration::from_secs(5);
    c
}

/// Router answers "loading" twice, then points at a worker that returns `clip`.
fn happy(worker: String, clip: &'static [u8], reported_hash: Option<String>) -> Handler {
    Arc::new(move |path, _body, count| match path {
        "/route/" if count < 3 => (
            200,
            json!({"status": "total workers: 1 loading workers: 1", "request_idx": count}),
        ),
        "/route/" => (
            200,
            json!({"url": worker, "request_idx": count, "signature": "sig"}),
        ),
        "/generate" => (
            200,
            json!({"video_b64": base64::engine::general_purpose::STANDARD.encode(clip),
                   "sha256": reported_hash.clone().unwrap_or_else(|| sha256_hex(clip)), "bytes": clip.len(),
                   "seconds": 31.26, "gpu": "NVIDIA GeForce RTX 5090", "bits": 8, "attention_backend": "sdpa",
                   "pan_commit": "0fb907b6", "label": "generated, not a measurement", "quality_validation": "pending"}),
        ),
        _ => (404, json!({})),
    })
}

/// One server plays both router and worker; the router points back at itself.
async fn both(clip: &'static [u8], reported_hash: Option<String>) -> (String, Seen) {
    let slot: Arc<Mutex<String>> = Arc::default();
    let reader = slot.clone();
    let delegate: Arc<Mutex<Option<Handler>>> = Arc::default();
    let inner = delegate.clone();
    let handler: Handler =
        Arc::new(move |p, b, c| (inner.lock().unwrap().as_ref().unwrap())(p, b, c));
    let (base, seen) = stand_in(handler).await;
    *slot.lock().unwrap() = base.clone();
    *delegate.lock().unwrap() = Some(happy(reader.lock().unwrap().clone(), clip, reported_hash));
    (base, seen)
}

#[tokio::test]
async fn polls_through_a_cold_start_then_writes_a_verified_clip() {
    let (base, seen) = both(b"fake-mp4-bytes", None).await;
    let renderer = VastRenderer::new(config(&base)).unwrap();
    let job = job("vast-happy", 9);
    let stats = renderer.render(&job).await.unwrap();

    assert_eq!(
        std::fs::read(job.step_dir.join(CLIP_FILE)).unwrap(),
        b"fake-mp4-bytes"
    );
    assert!(!job.step_dir.join("clip.mp4.part").exists());
    assert_eq!(
        (stats.seconds, stats.steps, stats.hardware.as_deref()),
        (31.3, 4, Some("NVIDIA GeForce RTX 5090"))
    );
    let note: Value =
        serde_json::from_slice(&std::fs::read(job.step_dir.join(VAST_FILE)).unwrap()).unwrap();
    assert_eq!(note["quality_validation"], "pending");
    assert!(
        note.get("video_b64").is_none(),
        "the clip bytes stay out of the note"
    );

    let seen = seen.lock().unwrap();
    let routes = seen.iter().filter(|(p, ..)| p == "/route/").count();
    assert_eq!(
        routes, 3,
        "two polls while the worker starts, then the reply with a url"
    );
    let (_, auth, body) = seen.iter().find(|(p, ..)| p == "/generate").unwrap();
    assert!(auth.contains(KEY));
    assert_eq!(
        body["auth_data"]["signature"], "sig",
        "the router's reply is forwarded to the worker"
    );
    let payload = &body["payload"];
    assert_eq!(
        (
            payload["frames"].as_u64(),
            payload["steps"].as_u64(),
            payload["seed"].as_u64()
        ),
        (Some(9), Some(4), Some(42))
    );
    assert_eq!(
        (payload["height"].as_u64(), payload["width"].as_u64()),
        (Some(256), Some(448))
    );
    assert!(payload["prompt"].as_str().unwrap().len() > 20);
}

#[tokio::test]
async fn a_clip_that_does_not_match_its_reported_hash_is_not_written() {
    let (base, _) = both(b"fake-mp4-bytes", Some("0".repeat(64))).await;
    let renderer = VastRenderer::new(config(&base)).unwrap();
    let job = job("vast-badhash", 9);
    let error = renderer.render(&job).await.unwrap_err();
    assert!(matches!(error, Pan2Error::MediaMismatch { .. }), "{error}");
    assert!(!job.step_dir.join(CLIP_FILE).exists());
    assert!(!job.step_dir.join(VAST_FILE).exists());
}

#[tokio::test]
async fn jobs_the_server_cannot_honour_are_refused_before_any_request() {
    let (base, seen) = both(b"x", None).await;
    let renderer = VastRenderer::new(config(&base)).unwrap();
    let too_long = job("vast-frames", 121);
    let bad_count = job("vast-8n", 8);
    let mut big_seed = job("vast-seed", 9);
    big_seed.generation_seed = 1 << 40;
    let mut with_image = job("vast-image", 9);
    with_image.image_path = Some("/tmp/frame.png".into());
    for refused in [&too_long, &bad_count, &big_seed, &with_image] {
        let error = renderer.render(refused).await.unwrap_err();
        assert!(matches!(error, Pan2Error::InvalidInput(_)), "{error}");
    }
    let mut oversized = config(&base);
    oversized.height = 512;
    oversized.width = 512;
    let error = VastRenderer::new(oversized)
        .unwrap()
        .render(&job("vast-pixels", 9))
        .await
        .unwrap_err();
    assert!(matches!(error, Pan2Error::InvalidInput(_)), "{error}");
    assert!(
        seen.lock().unwrap().is_empty(),
        "nothing reached the network"
    );
}

#[tokio::test]
async fn a_worker_that_never_starts_ends_in_a_bounded_error() {
    let handler: Handler =
        Arc::new(|_, _, count| (200, json!({"status": "loading", "request_idx": count})));
    let (base, _) = stand_in(handler).await;
    let mut c = config(&base);
    c.route_wait = Duration::from_millis(200);
    let error = VastRenderer::new(c)
        .unwrap()
        .render(&job("vast-timeout", 9))
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("no worker became ready"),
        "{error}"
    );
}

#[tokio::test]
async fn router_refusal_and_worker_errors_are_classified_and_never_echo_the_key() {
    let (base, _) = stand_in(Arc::new(|_, _, _| (401, json!({"error": "bad key"})))).await;
    let error = VastRenderer::new(config(&base))
        .unwrap()
        .render(&job("vast-401", 9))
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("HTTP 401") && !error.to_string().contains(KEY),
        "{error}"
    );

    let worker = Arc::new(Mutex::new(String::new()));
    let w = worker.clone();
    let (base, _) = stand_in(Arc::new(move |path, _, _| match path {
        "/route/" => (200, json!({"url": w.lock().unwrap().clone()})),
        _ => (400, json!({"error": "frames must be 8n+1"})),
    }))
    .await;
    *worker.lock().unwrap() = base.clone();
    let error = VastRenderer::new(config(&base))
        .unwrap()
        .render(&job("vast-400", 9))
        .await
        .unwrap_err();
    assert!(matches!(error, Pan2Error::InvalidInput(_)), "{error}");

    let worker = Arc::new(Mutex::new(String::new()));
    let w = worker.clone();
    let (base, _) = stand_in(Arc::new(move |path, _, _| match path {
        "/route/" => (200, json!({"url": w.lock().unwrap().clone()})),
        _ => (500, json!({"error": "CUDA out of memory"})),
    }))
    .await;
    *worker.lock().unwrap() = base.clone();
    let c = config(&base);
    assert!(
        !format!("{c:?}").contains(KEY),
        "Debug output redacts the key"
    );
    let error = VastRenderer::new(c)
        .unwrap()
        .render(&job("vast-500", 9))
        .await
        .unwrap_err();
    assert!(
        matches!(error, Pan2Error::Renderer(_)) && error.to_string().contains("HTTP 500"),
        "{error}"
    );
    assert!(!error.to_string().contains(KEY));
}
