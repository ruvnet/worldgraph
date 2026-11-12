//! Live check of a Vast serverless endpoint through the real renderer. Spends GPU time: run it deliberately.
//!
//! `VAST_API_KEY=... cargo run -p worldgraph-pan2 --features vast --example vast_probe -- <endpoint> <out-dir>`
//!
//! Renders one 9-frame smoke clip (the endpoint's default caps), so it proves the wiring and the hash
//! check, not video quality. The key is read from the environment and never printed.

use worldgraph_pan2::compile::compile;
use worldgraph_pan2::vast::{fetch_root_cert, VastConfig, VastRenderer};
use worldgraph_pan2::worker::{RenderJob, Renderer, RendererIdentity};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let (Some(endpoint), Some(out)) = (args.next(), args.next()) else {
        eprintln!("usage: vast_probe <endpoint> <out-dir>   (key in VAST_API_KEY)");
        std::process::exit(2);
    };
    let key = std::env::var("VAST_API_KEY").map_err(|_| "set VAST_API_KEY")?;
    let identity = RendererIdentity {
        model: worldgraph_pan2::PAN2_MODEL.into(),
        checkpoint: "unrecorded".into(),
        runtime_version: "vast-serverless".into(),
    };
    let mut config = VastConfig::new(endpoint, key, identity);
    config.root_cert = Some(fetch_root_cert().await?);
    let renderer = VastRenderer::new(config)?;

    // A one-second plan compiles to 25 frames; the smoke endpoint serves 9, so shorten the compiled job.
    let plan: worldgraph_pan2::plan::RolloutPlan = serde_json::from_value(serde_json::json!({
        "name": "vast probe",
        "source_snapshot_hash": format!("sha256:{}", "0".repeat(64)),
        "source_stream_epoch": 1,
        "generation_seed": 7,
        "projection_id": "probe",
        "hosted_processing_approved": true,
        "duration_sec": 1.0,
        "first_frame": "A small yellow warehouse robot in a long aisle between shelves of boxes."
    }))?;
    let (seed, action) = plan.into_inputs(0, 0)?;
    let mut prompt = compile(&seed, &action)?;
    prompt.frames = 9;
    std::fs::create_dir_all(&out)?;
    let job = RenderJob {
        prompt,
        generation_seed: 7,
        step_dir: out.clone().into(),
        image_path: None,
    };
    let started = std::time::Instant::now();
    let stats = renderer.render(&job).await?;
    println!(
        "clip written to {out}/clip.mp4 in {:.0}s total; worker generation {:.1}s on {:?}",
        started.elapsed().as_secs_f64(),
        stats.seconds,
        stats.hardware
    );
    Ok(())
}
