//! The `worldgraph.simulated.rollout` bundle read by RuLab.
//!
//! A bundle is a flat directory: `rollout.json`, the clip, the exact caption
//! sent to the model, and optionally the conditioning image. It is a separate
//! format from the ADR-206 capture bundle on purpose: a rollout is a model
//! prediction and must never be opened by the capture player.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use wifi_densepose_worldmodel::SimulatedFrameEnvelope;

use crate::media::{check_flat_name, check_sha256, sha256_file, verify_frame};
use crate::worker::{RenderStats, CAPTION_FILE, CLIP_FILE, GENERATION_FILE};
use crate::Pan2Error;

/// Value of `format` in every rollout manifest.
pub const ROLLOUT_FORMAT: &str = "worldgraph.simulated.rollout";
/// Manifest file name inside a bundle directory.
pub const ROLLOUT_MANIFEST: &str = "rollout.json";
/// Largest clip a bundle may carry (64 MiB).
pub const MAX_BUNDLE_MEDIA_BYTES: u64 = 64 * 1024 * 1024;
/// Largest caption a bundle may carry (64 KiB).
pub const MAX_BUNDLE_CAPTION_BYTES: u64 = 64 * 1024;
/// Largest conditioning image a bundle may carry (8 MiB).
pub const MAX_BUNDLE_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

/// A hashed file in the bundle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BundleFile {
    /// Flat file name.
    pub file: String,
    /// Lowercase hex SHA-256 of the file bytes.
    pub sha256: String,
    /// File size.
    pub bytes: u64,
}

/// The clip and its playback parameters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BundleMedia {
    /// Flat `.mp4` file name.
    pub file: String,
    /// Lowercase hex SHA-256 of the clip bytes.
    pub sha256: String,
    /// Clip size.
    pub bytes: u64,
    /// Always `video/mp4`.
    pub media_type: String,
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// Frames per second.
    pub fps: u32,
    /// Requested clip length in seconds.
    pub duration_sec: f64,
}

/// Measured generation facts shown beside the clip. Every field is optional.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BundleGeneration {
    /// GPU that produced the clip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hardware: Option<String>,
    /// Sampler steps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steps: Option<u32>,
    /// Wall-clock seconds, model load included.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seconds: Option<f64>,
    /// Peak GPU memory in gibibytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peak_vram_gb: Option<f64>,
}

/// `rollout.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RolloutManifest {
    /// Always [`ROLLOUT_FORMAT`].
    pub format: String,
    /// Always `1`.
    pub version: u32,
    /// Display name, 1 to 120 characters.
    pub name: String,
    /// Always `true`.
    pub simulated: bool,
    /// The clip.
    pub media: BundleMedia,
    /// The exact caption sent to the model.
    pub caption: BundleFile,
    /// Conditioning image for image-to-video rollouts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_frame: Option<BundleFile>,
    /// The ADR-204 envelope, with its snake_case field names.
    pub envelope: SimulatedFrameEnvelope,
    /// Measured generation facts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<BundleGeneration>,
}

impl RolloutManifest {
    /// Checks every rule a reader relies on, without touching the filesystem.
    pub fn validate(&self) -> Result<(), Pan2Error> {
        let contract = |message: &str| Err(Pan2Error::Contract(message.to_owned()));
        if self.format != ROLLOUT_FORMAT || self.version != 1 {
            return contract("unsupported rollout format or version");
        }
        if !self.simulated || !self.envelope.chunk.provenance.simulated {
            return contract("a rollout must be marked simulated");
        }
        let name_chars = self.name.chars().count();
        if name_chars == 0
            || name_chars > 120
            || self.name.trim() != self.name
            || self.name.chars().any(|c| c.is_ascii_control())
        {
            return contract("name must be 1 to 120 trimmed characters without control characters");
        }
        check_flat_name(&self.media.file, &["mp4"])?;
        check_sha256(&self.media.sha256)?;
        check_flat_name(&self.caption.file, &["json"])?;
        check_sha256(&self.caption.sha256)?;
        if self.media.media_type != "video/mp4" {
            return contract("media type must be video/mp4");
        }
        if self.media.bytes == 0 || self.media.bytes > MAX_BUNDLE_MEDIA_BYTES {
            return contract("clip must be 1 byte to 64 MiB");
        }
        if self.caption.bytes == 0 || self.caption.bytes > MAX_BUNDLE_CAPTION_BYTES {
            return contract("caption must be 1 byte to 64 KiB");
        }
        if !(16..=4096).contains(&self.media.width)
            || !(16..=4096).contains(&self.media.height)
            || !(1..=120).contains(&self.media.fps)
            || !self.media.duration_sec.is_finite()
            || self.media.duration_sec <= 0.0
            || self.media.duration_sec > 20.0
        {
            return contract("clip dimensions, frame rate or duration are out of range");
        }
        if let Some(image) = &self.first_frame {
            check_flat_name(&image.file, &["png", "jpg", "jpeg"])?;
            check_sha256(&image.sha256)?;
            if image.bytes == 0 || image.bytes > MAX_BUNDLE_IMAGE_BYTES {
                return contract("first frame must be 1 byte to 8 MiB");
            }
        }
        let video = self
            .envelope
            .chunk
            .frames
            .iter()
            .find(|frame| frame.media_type == "video/mp4");
        match video {
            Some(frame)
                if frame.content_hash == format!("sha256:{}", self.media.sha256)
                    && frame.byte_length == self.media.bytes => {}
            _ => return contract("the envelope's video descriptor does not match the clip"),
        }
        Ok(())
    }

    /// Validates the manifest and re-hashes every file it names under `dir`.
    pub fn verify_files(&self, dir: &Path) -> Result<(), Pan2Error> {
        self.validate()?;
        let mut files = vec![
            (&self.media.file, &self.media.sha256, self.media.bytes),
            (&self.caption.file, &self.caption.sha256, self.caption.bytes),
        ];
        if let Some(image) = &self.first_frame {
            files.push((&image.file, &image.sha256, image.bytes));
        }
        for (file, sha256, bytes) in files {
            let (actual, length) = sha256_file(&dir.join(file))?;
            if &actual != sha256 || length != bytes {
                return Err(Pan2Error::MediaMismatch {
                    file: file.clone(),
                    reason: "bundle file does not match its manifest entry".into(),
                });
            }
        }
        Ok(())
    }
}

/// Inputs for [`write_bundle`].
#[derive(Debug, Clone)]
pub struct BundleRequest<'a> {
    /// Display name.
    pub name: &'a str,
    /// Envelope returned by the provider for this step.
    pub envelope: &'a SimulatedFrameEnvelope,
    /// Local copy of the worker's media root.
    pub media_root: &'a Path,
    /// Destination directory; created if missing.
    pub out_dir: &'a Path,
    /// Requested clip length in seconds.
    pub duration_sec: f64,
    /// Output width in pixels.
    pub width: u32,
    /// Output height in pixels.
    pub height: u32,
    /// Local conditioning image and its expected SHA-256, for image-to-video.
    pub first_frame: Option<(&'a Path, &'a str)>,
}

/// Verifies every described file against the envelope, copies the bundle
/// files into `out_dir`, and writes `rollout.json`.
///
/// Nothing is written unless the clip and caption match their descriptors.
pub fn write_bundle(request: &BundleRequest<'_>) -> Result<RolloutManifest, Pan2Error> {
    let frames = &request.envelope.chunk.frames;
    let frame = |suffix: &str| {
        frames
            .iter()
            .find(|frame| frame.locator.ends_with(&format!("/{suffix}")))
            .ok_or_else(|| Pan2Error::Contract(format!("envelope has no `{suffix}` descriptor")))
    };
    let clip_frame = frame(CLIP_FILE)?;
    let caption_frame = frame(CAPTION_FILE)?;
    let clip = verify_frame(request.media_root, clip_frame)?;
    let caption = verify_frame(request.media_root, caption_frame)?;
    let generation = match frame(GENERATION_FILE) {
        Ok(descriptor) => {
            let path = verify_frame(request.media_root, descriptor)?;
            let stats: RenderStats = serde_json::from_slice(&std::fs::read(path)?)?;
            Some(BundleGeneration {
                hardware: stats.hardware,
                steps: Some(stats.steps),
                seconds: Some(stats.seconds),
                peak_vram_gb: stats.peak_vram_gb,
            })
        }
        Err(_) => None,
    };

    let first_frame = match request.first_frame {
        Some((path, expected)) => {
            let (sha256, bytes) = sha256_file(path)?;
            if sha256 != expected {
                return Err(Pan2Error::MediaMismatch {
                    file: path.display().to_string(),
                    reason: "conditioning image does not match the plan".into(),
                });
            }
            let extension = path
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or("png");
            Some((
                path,
                BundleFile {
                    file: format!("first.{extension}"),
                    sha256,
                    bytes,
                },
            ))
        }
        None => None,
    };

    let hash_of = |descriptor: &wifi_densepose_worldmodel::FrameDescriptor| {
        descriptor
            .content_hash
            .trim_start_matches("sha256:")
            .to_owned()
    };
    let manifest = RolloutManifest {
        format: ROLLOUT_FORMAT.into(),
        version: 1,
        name: request.name.to_owned(),
        simulated: true,
        media: BundleMedia {
            file: CLIP_FILE.into(),
            sha256: hash_of(clip_frame),
            bytes: clip_frame.byte_length,
            media_type: "video/mp4".into(),
            width: request.width,
            height: request.height,
            fps: crate::compile::FPS,
            duration_sec: request.duration_sec,
        },
        caption: BundleFile {
            file: CAPTION_FILE.into(),
            sha256: hash_of(caption_frame),
            bytes: caption_frame.byte_length,
        },
        first_frame: first_frame.as_ref().map(|(_, file)| file.clone()),
        envelope: request.envelope.clone(),
        generation,
    };
    manifest.validate()?;

    std::fs::create_dir_all(request.out_dir)?;
    std::fs::copy(&clip, request.out_dir.join(CLIP_FILE))?;
    std::fs::copy(&caption, request.out_dir.join(CAPTION_FILE))?;
    if let Some((source, file)) = &first_frame {
        std::fs::copy(source, request.out_dir.join(&file.file))?;
    }
    let mut json = serde_json::to_vec_pretty(&manifest)?;
    json.push(b'\n');
    std::fs::write(request.out_dir.join(ROLLOUT_MANIFEST), json)?;
    manifest.verify_files(request.out_dir)?;
    Ok(manifest)
}

/// Reads and fully verifies a bundle directory.
pub fn read_bundle(dir: &Path) -> Result<RolloutManifest, Pan2Error> {
    let manifest: RolloutManifest =
        serde_json::from_slice(&std::fs::read(dir.join(ROLLOUT_MANIFEST))?)?;
    manifest.verify_files(dir)?;
    Ok(manifest)
}

/// Path of the manifest inside a bundle directory.
pub fn manifest_path(dir: &Path) -> PathBuf {
    dir.join(ROLLOUT_MANIFEST)
}
