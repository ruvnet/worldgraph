//! Renderer that runs the unmodified upstream PAN 2 `generate.py`.
//!
//! No model code lives in this crate. The renderer writes a one-record prompt
//! JSON, starts the upstream generator as a child process with the released
//! sampler settings, waits for it, and moves the resulting clip into place.
//! Every invocation loads the model, so the reported time includes model load.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::process::Command;

use crate::worker::{RenderFuture, RenderJob, RenderStats, Renderer, RendererIdentity, CLIP_FILE};
use crate::Pan2Error;

/// How to invoke the upstream generator on this host.
#[derive(Debug, Clone)]
pub struct GenerateConfig {
    /// Checkout of `ifm-ai/PAN2`; the working directory of the child.
    pub pan_root: PathBuf,
    /// `torchrun` from the environment that has PAN 2's dependencies.
    pub torchrun: PathBuf,
    /// Native-layout transformer checkpoint directory.
    pub checkpoint: PathBuf,
    /// Architecture YAML, relative to `pan_root` or absolute.
    pub training_config: PathBuf,
    /// Fallback negative prompt, relative to `pan_root` or absolute.
    pub negative_prompt_file: PathBuf,
    /// Sampler steps (released default: 50).
    pub steps: u32,
    /// Flow shift (released default: 9).
    pub flow_shift: f32,
    /// Classifier-free guidance scale (released default: 2.5).
    pub guidance_scale: f32,
    /// Output height in pixels.
    pub height: u32,
    /// Output width in pixels.
    pub width: u32,
    /// Upstream `--offload` mode: `none`, `models`, `blocks` or `auto`.
    pub offload: String,
    /// H.264 constant rate factor.
    pub video_crf: u32,
    /// Pixel format. `yuv420p` plays in browsers; upstream defaults to `yuv444p`.
    pub video_pixel_format: String,
    /// Extra arguments appended to the `generate.py` command line.
    pub extra_args: Vec<String>,
    /// Hard limit for one invocation.
    pub timeout: Duration,
    /// Identity recorded in provenance.
    pub identity: RendererIdentity,
}

impl GenerateConfig {
    /// Released sampler defaults for a checkout, environment and checkpoint.
    pub fn new(
        pan_root: impl Into<PathBuf>,
        torchrun: impl Into<PathBuf>,
        checkpoint: impl Into<PathBuf>,
        identity: RendererIdentity,
    ) -> Self {
        Self {
            pan_root: pan_root.into(),
            torchrun: torchrun.into(),
            checkpoint: checkpoint.into(),
            training_config: "config/sft_29B_720p.yaml".into(),
            negative_prompt_file: "inference/prompts/negative_prompt.json".into(),
            steps: 50,
            flow_shift: 9.0,
            guidance_scale: 2.5,
            height: 704,
            width: 1248,
            offload: "auto".into(),
            video_crf: 20,
            video_pixel_format: "yuv420p".into(),
            extra_args: Vec::new(),
            timeout: Duration::from_secs(3 * 60 * 60),
            identity,
        }
    }

    /// The exact `generate.py` argument list for one job.
    pub fn arguments(&self, job: &RenderJob, prompt_json: &Path, output_dir: &Path) -> Vec<String> {
        let path = |p: &Path| p.display().to_string();
        let mut args = vec![
            "--standalone".to_owned(),
            "--nnodes=1".to_owned(),
            "--nproc_per_node=1".to_owned(),
            "generate.py".to_owned(),
        ];
        let pairs: [(&str, String); 21] = [
            ("--task", "auto".into()),
            ("--prompt_json", path(prompt_json)),
            ("--output_dir", path(output_dir)),
            ("--prompt_shard_index", "0".into()),
            ("--prompt_shard_count", "1".into()),
            ("--checkpoint_path", path(&self.checkpoint)),
            ("--training_config", path(&self.training_config)),
            ("--num_inference_steps", self.steps.to_string()),
            ("--flow_shift", self.flow_shift.to_string()),
            ("--guidance_scale", self.guidance_scale.to_string()),
            ("--negative_prompt_file", path(&self.negative_prompt_file)),
            ("--video_height", self.height.to_string()),
            ("--video_width", self.width.to_string()),
            ("--fps", crate::compile::FPS.to_string()),
            ("--video_length", job.prompt.frames.to_string()),
            ("--seed", job.generation_seed.to_string()),
            ("--dtype", "bf16".into()),
            ("--i2v_skip_first_latent_cfg", "true".into()),
            ("--offload", self.offload.clone()),
            ("--video_crf", self.video_crf.to_string()),
            ("--video_pixel_format", self.video_pixel_format.clone()),
        ];
        for (flag, value) in pairs {
            args.push(flag.to_owned());
            args.push(value);
        }
        args.extend(
            [
                "--skip_existing",
                "false",
                "--save_settings",
                "true",
                "--video_preset",
                "slow",
            ]
            .map(String::from),
        );
        args.extend(self.extra_args.iter().cloned());
        args
    }
}

/// [`Renderer`] backed by a child `torchrun generate.py` process.
#[derive(Debug, Clone)]
pub struct GenerateCommandRenderer {
    config: GenerateConfig,
}

impl GenerateCommandRenderer {
    /// Wraps a configuration. Nothing is started until a job arrives.
    pub fn new(config: GenerateConfig) -> Self {
        Self { config }
    }

    async fn run(&self, job: &RenderJob) -> Result<RenderStats, Pan2Error> {
        let work = job.step_dir.join("work");
        tokio::fs::create_dir_all(&work).await?;
        let prompt_json = work.join("prompts.json");
        let image = job.image_path.as_ref().map(|p| p.display().to_string());
        let record = job.prompt.prompt_record(CLIP_FILE, image.as_deref());
        tokio::fs::write(&prompt_json, serde_json::to_vec_pretty(&[record])?).await?;

        let log = std::fs::File::create(job.step_dir.join("generate.log"))?;
        let started = Instant::now();
        let mut child = Command::new(&self.config.torchrun)
            .args(self.config.arguments(job, &prompt_json, &work))
            .current_dir(&self.config.pan_root)
            .env("CUDA_VISIBLE_DEVICES", "0")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env("PYTORCH_ALLOC_CONF", "expandable_segments:True")
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log)
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| Pan2Error::Renderer(format!("cannot start torchrun: {error}")))?;

        let mut peak_mib = 0_u64;
        let mut hardware = None;
        let status = loop {
            tokio::select! {
                status = child.wait() => break status?,
                () = tokio::time::sleep(Duration::from_secs(5)) => {
                    if started.elapsed() > self.config.timeout {
                        let _ = child.kill().await;
                        return Err(Pan2Error::Renderer("generator exceeded its time limit".into()));
                    }
                    if let Some((name, used)) = gpu_sample().await {
                        peak_mib = peak_mib.max(used);
                        hardware.get_or_insert(name);
                    }
                }
            }
        };
        if !status.success() {
            return Err(Pan2Error::Renderer(format!(
                "generator exited with {status}; see generate.log in the step directory"
            )));
        }
        let clip = find_mp4(&work)?.ok_or_else(|| {
            Pan2Error::Renderer("generator finished without writing an mp4".into())
        })?;
        tokio::fs::rename(&clip, job.step_dir.join(CLIP_FILE)).await?;
        Ok(RenderStats {
            seconds: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
            steps: self.config.steps,
            hardware,
            peak_vram_gb: (peak_mib > 0).then(|| (peak_mib as f64 / 1024.0 * 10.0).round() / 10.0),
        })
    }
}

impl Renderer for GenerateCommandRenderer {
    fn identity(&self) -> RendererIdentity {
        self.config.identity.clone()
    }

    fn render<'a>(&'a self, job: &'a RenderJob) -> RenderFuture<'a> {
        Box::pin(self.run(job))
    }
}

/// `(GPU name, memory used in MiB)` for GPU 0, when `nvidia-smi` is available.
async fn gpu_sample() -> Option<(String, u64)> {
    let output = Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,memory.used",
            "--format=csv,noheader,nounits",
            "--id=0",
        ])
        .output()
        .await
        .ok()?;
    parse_gpu_sample(std::str::from_utf8(&output.stdout).ok()?)
}

fn parse_gpu_sample(text: &str) -> Option<(String, u64)> {
    let (name, used) = text.lines().next()?.rsplit_once(',')?;
    Some((name.trim().to_owned(), used.trim().parse().ok()?))
}

/// The single mp4 under `dir`, searched recursively. More than one is an error.
fn find_mp4(dir: &Path) -> Result<Option<PathBuf>, Pan2Error> {
    let mut found = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(current) = pending.pop() {
        for entry in std::fs::read_dir(&current)? {
            let path = entry?.path();
            if path.is_dir() {
                pending.push(path);
            } else if path.extension().is_some_and(|ext| ext == "mp4") {
                found.push(path);
            }
        }
    }
    if found.len() > 1 {
        return Err(Pan2Error::Renderer(format!(
            "generator wrote {} mp4 files; expected one",
            found.len()
        )));
    }
    Ok(found.pop())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compile::compile;

    fn identity() -> RendererIdentity {
        RendererIdentity {
            model: "IFM/PAN2".into(),
            checkpoint: "rev".into(),
            runtime_version: "commit".into(),
        }
    }

    #[test]
    fn arguments_carry_the_released_sampler_and_the_job_values() {
        let (seed, action) = crate::plan::tests::door_plan().into_inputs(0, 0).unwrap();
        let job = RenderJob {
            prompt: compile(&seed, &action).unwrap(),
            generation_seed: 123,
            step_dir: "/media/s/e0-s0".into(),
            image_path: None,
        };
        let config = GenerateConfig::new("/pan", "/env/bin/torchrun", "/w/transformer", identity());
        let args = config.arguments(&job, Path::new("/p.json"), Path::new("/out"));
        let value = |flag: &str| {
            let index = args.iter().position(|arg| arg == flag).unwrap();
            args[index + 1].as_str()
        };
        assert_eq!(
            &args[..4],
            [
                "--standalone",
                "--nnodes=1",
                "--nproc_per_node=1",
                "generate.py"
            ]
        );
        assert_eq!(value("--num_inference_steps"), "50");
        assert_eq!(value("--flow_shift"), "9");
        assert_eq!(value("--guidance_scale"), "2.5");
        assert_eq!(value("--video_length"), "121");
        assert_eq!(value("--seed"), "123");
        assert_eq!(value("--video_height"), "704");
        assert_eq!(value("--video_width"), "1248");
        assert_eq!(value("--video_pixel_format"), "yuv420p");
        assert_eq!(value("--checkpoint_path"), "/w/transformer");
    }

    #[test]
    fn gpu_sample_parsing() {
        assert_eq!(
            parse_gpu_sample("NVIDIA H200, 98765\n"),
            Some(("NVIDIA H200".into(), 98_765))
        );
        assert_eq!(parse_gpu_sample(""), None);
        assert_eq!(parse_gpu_sample("no comma"), None);
    }

    #[test]
    fn mp4_search_finds_one_and_rejects_several() {
        let dir = std::env::temp_dir().join(format!("worldgraph-pan2-find-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("t2v")).unwrap();
        assert_eq!(find_mp4(&dir).unwrap(), None);
        std::fs::write(dir.join("t2v/clip.mp4"), b"x").unwrap();
        assert_eq!(find_mp4(&dir).unwrap(), Some(dir.join("t2v/clip.mp4")));
        std::fs::write(dir.join("other.mp4"), b"y").unwrap();
        assert!(find_mp4(&dir).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
