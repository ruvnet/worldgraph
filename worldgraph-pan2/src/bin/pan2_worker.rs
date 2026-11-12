//! `pan2-worker` — ADR-204 sidecar for a GPU host that has PAN 2 installed.
//!
//! Listens on a Unix socket, compiles each step into a PAN 2 caption, runs the
//! unmodified upstream `generate.py`, and returns hashed file descriptors.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use worldgraph_pan2::renderer::{GenerateCommandRenderer, GenerateConfig};
use worldgraph_pan2::worker::{serve, RendererIdentity, Worker};
use worldgraph_pan2::{Pan2Error, PAN2_MODEL};

const USAGE: &str = "\
pan2-worker --socket <path> --media-root <dir> --image-root <dir>
            --pan-root <PAN2 checkout> --torchrun <path> --checkpoint <transformer dir>
            --model-revision <Hugging Face revision> --runtime-commit <PAN2 commit>
            [--instance <name>] [--steps 50] [--offload auto] [--crf 20]
            [--extra-arg <generate.py argument>]...

Every flag takes one value. --extra-arg may repeat.";

fn arguments() -> Result<(BTreeMap<String, String>, Vec<String>), Pan2Error> {
    let mut values = BTreeMap::new();
    let mut extra = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let name = flag
            .strip_prefix("--")
            .ok_or_else(|| Pan2Error::InvalidInput(format!("unexpected argument `{flag}`")))?;
        let value = args
            .next()
            .ok_or_else(|| Pan2Error::InvalidInput(format!("`{flag}` needs a value")))?;
        if name == "extra-arg" {
            extra.push(value);
        } else if values.insert(name.to_owned(), value).is_some() {
            return Err(Pan2Error::InvalidInput(format!("`{flag}` given twice")));
        }
    }
    Ok((values, extra))
}

async fn run() -> Result<(), Pan2Error> {
    let (mut values, extra_args) = arguments()?;
    let mut take = |name: &str| {
        values
            .remove(name)
            .ok_or_else(|| Pan2Error::InvalidInput(format!("missing --{name}")))
    };
    let socket = PathBuf::from(take("socket")?);
    let media_root = PathBuf::from(take("media-root")?);
    let image_root = PathBuf::from(take("image-root")?);
    let identity = RendererIdentity {
        model: PAN2_MODEL.to_owned(),
        checkpoint: take("model-revision")?,
        runtime_version: format!("ifm-ai/PAN2@{}", take("runtime-commit")?),
    };
    let mut config = GenerateConfig::new(
        take("pan-root")?,
        take("torchrun")?,
        take("checkpoint")?,
        identity,
    );
    let instance = values.remove("instance").unwrap_or_else(|| "w".to_owned());
    let number = |name: &str, text: String| {
        text.parse::<u32>()
            .map_err(|_| Pan2Error::InvalidInput(format!("--{name} must be a whole number")))
    };
    if let Some(steps) = values.remove("steps") {
        config.steps = number("steps", steps)?;
    }
    if let Some(crf) = values.remove("crf") {
        config.video_crf = number("crf", crf)?;
    }
    if let Some(offload) = values.remove("offload") {
        config.offload = offload;
    }
    config.extra_args = extra_args;
    if let Some(unknown) = values.keys().next() {
        return Err(Pan2Error::InvalidInput(format!("unknown flag --{unknown}")));
    }
    for (label, path) in [
        ("--pan-root", config.pan_root.join("generate.py")),
        ("--torchrun", config.torchrun.clone()),
        ("--checkpoint", config.checkpoint.clone()),
    ] {
        if !path.exists() {
            return Err(Pan2Error::InvalidInput(format!(
                "{label}: `{}` does not exist",
                path.display()
            )));
        }
    }
    std::fs::create_dir_all(&media_root)?;
    std::fs::create_dir_all(&image_root)?;

    let worker = Arc::new(Worker::new(
        GenerateCommandRenderer::new(config),
        media_root,
        image_root,
        &instance,
    )?);
    eprintln!("pan2-worker listening on {}", socket.display());
    serve(worker, &socket, async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pan2-worker: {error}\n\n{USAGE}");
            ExitCode::FAILURE
        }
    }
}
