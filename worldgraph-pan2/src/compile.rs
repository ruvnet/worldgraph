//! Deterministic compiler from the ADR-204 session inputs to a PAN 2 prompt.
//!
//! The sidecar protocol only carries a [`SceneSeed`] and an [`ActionChunk`], so
//! everything PAN 2 needs is encoded in those two values:
//!
//! | Source | Becomes |
//! | --- | --- |
//! | `seed.prompt` | start of `init_frame_visual_description` |
//! | `seed.scene` | a layout sentence appended to that description |
//! | `seed.metadata["pan2.style" / "pan2.lighting" / "pan2.view" / "pan2.quality"]` | the matching caption fields |
//! | `seed.metadata["pan2.subject.N"]` = `name\|attribute` | `subjects_lifecycle` |
//! | `seed.metadata["pan2.image"]`, `["pan2.image.sha256"]` | image-to-video conditioning frame |
//! | `action.samples` | clip duration and `camera_motion` intervals |
//! | `action.metadata["pan2.event.N"]` = `<a> to <b>\|prose` | `events` |
//! | `action.metadata["pan2.act.N"]` = `<a> to <b>\|subject\|text` | `contained_actions` |
//!
//! [`crate::plan::RolloutPlan`] writes these keys so callers do not have to.
//! The same function runs on the client (to hash and preview the caption) and
//! in the GPU-side worker (to build the prompt), so both sides agree by
//! construction.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use wifi_densepose_worldmodel::{ActionChunk, ActionSample, SceneSeed};

use crate::caption::{
    format_range, frames_for, parse_range, subject_id, CameraInterval, CameraTag, ContainedAction,
    Event, Pan2Caption, Quality, Subject, MAX_DURATION_DS, MAX_SUBJECTS, MIN_DURATION_DS,
};
use crate::layout::init_description;
use crate::media::sha256_hex;
use crate::Pan2Error;

/// Output frame rate used by the released PAN 2 sampler.
pub const FPS: u32 = 24;
/// Translation or rotation rate below which a camera axis is treated as still.
pub const CAMERA_DEADBAND: f32 = 0.05;

const DEFAULT_STYLE: &str =
    "Realistic documentary footage of an indoor facility in one uninterrupted continuous shot.";
const DEFAULT_LIGHTING: &str =
    "Even, neutral overhead interior lighting with soft shadows and natural material colours.";
const DEFAULT_VIEW: &str =
    "Eye-level view from the south edge of the space, looking north across the room.";
const DEFAULT_QUALITY: &str =
    "Stable room geometry and object forms, resolved surface detail, natural motion blur only on fast movement.";
const DEFAULT_EVENT: &str = "The view continues through the space with no other change.";

/// Generation task implied by the seed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Task {
    /// Text-to-video.
    T2v,
    /// Image-to-video, conditioned on a first frame.
    I2v,
}

/// Conditioning image named by the seed. The bytes travel on the media channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageRef {
    /// Flat file name inside the worker's image directory.
    pub file: String,
    /// Expected SHA-256 of the image bytes, lowercase hex.
    pub sha256: String,
}

/// A caption plus everything the generator needs alongside it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompiledPrompt {
    /// Structured caption.
    pub caption: Pan2Caption,
    /// Compact serialization of `caption`; the model's `refined_prompt`.
    pub prompt: String,
    /// SHA-256 of `prompt`, lowercase hex.
    pub prompt_sha256: String,
    /// Clip length in tenths of a second.
    pub duration_ds: u32,
    /// Frames rendered at [`FPS`].
    pub frames: u32,
    /// Text-to-video or image-to-video.
    pub task: Task,
    /// Conditioning image for image-to-video.
    pub image: Option<ImageRef>,
}

impl CompiledPrompt {
    /// Clip length in seconds.
    pub fn duration_sec(&self) -> f64 {
        f64::from(self.duration_ds) / 10.0
    }

    /// One record of the prompt JSON accepted by upstream `generate.py`.
    ///
    /// `image_path` must be the path of the verified image on the GPU host.
    pub fn prompt_record(
        &self,
        relative_path: &str,
        image_path: Option<&str>,
    ) -> serde_json::Value {
        let mut record = serde_json::json!({
            "type": match self.task { Task::T2v => "t2v", Task::I2v => "i2v" },
            "refined_prompt": self.prompt,
            "duration_sec": self.duration_sec(),
            "relative_path": relative_path,
        });
        if let Some(path) = image_path {
            record["image_path"] = serde_json::Value::String(path.to_owned());
        }
        record
    }
}

/// Compiles session inputs into a validated PAN 2 prompt.
pub fn compile(seed: &SceneSeed, action: &ActionChunk) -> Result<CompiledPrompt, Pan2Error> {
    let duration_ds = duration_ds(&action.samples)?;
    let subjects = subjects(&seed.metadata)?;
    let event_spans = event_spans(&action.metadata, duration_ds)?;
    let actions = actions(&action.metadata, &subjects)?;
    let camera = camera_intervals(&action.samples)?;

    let mut events = Vec::with_capacity(event_spans.len());
    for (index, (start, end, description)) in event_spans.iter().enumerate() {
        events.push(Event {
            event_index: index as u32,
            time_range_sec: format_range(*start, *end),
            event_description: description.clone(),
            camera_motion: clip_camera(&camera, *start, *end),
            contained_actions: Vec::new(),
        });
    }
    for (start, end, text) in actions {
        let owner = event_spans
            .iter()
            .position(|(from, to, _)| start >= *from && end <= *to)
            .ok_or_else(|| {
                Pan2Error::invalid(format!(
                    "action `{}` crosses an event boundary; split it or merge the events",
                    format_range(start, end)
                ))
            })?;
        events[owner].contained_actions.push(ContainedAction {
            time_range_sec: format_range(start, end),
            action: text,
        });
    }

    let caption = Pan2Caption {
        video_style: style(&seed.metadata),
        lighting: text_or(&seed.metadata, "pan2.lighting", DEFAULT_LIGHTING),
        perspective_view: text_or(&seed.metadata, "pan2.view", DEFAULT_VIEW),
        subjects_lifecycle: subjects,
        init_frame_visual_description: init_description(seed)?,
        events,
        quality: Quality {
            video_quality: text_or(&seed.metadata, "pan2.quality", DEFAULT_QUALITY),
            text_logos_overlays: None,
            artifacts: None,
        },
    };
    let prompt = caption.to_prompt_string()?;
    let image = image(&seed.metadata)?;
    Ok(CompiledPrompt {
        prompt_sha256: sha256_hex(prompt.as_bytes()),
        prompt,
        caption,
        duration_ds,
        frames: frames_for(duration_ds, FPS),
        task: if image.is_some() {
            Task::I2v
        } else {
            Task::T2v
        },
        image,
    })
}

fn text_or(metadata: &BTreeMap<String, String>, key: &str, default: &str) -> String {
    metadata
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or(default)
        .to_owned()
}

fn style(metadata: &BTreeMap<String, String>) -> String {
    let style = text_or(metadata, "pan2.style", DEFAULT_STYLE);
    if style.to_ascii_lowercase().contains("continuous") {
        style
    } else {
        // The caption policy requires the single-take statement exactly once.
        format!("{} One uninterrupted continuous shot.", style.trim_end())
    }
}

fn duration_ds(samples: &[ActionSample]) -> Result<u32, Pan2Error> {
    if samples.len() < 2 {
        return Err(Pan2Error::invalid(
            "an action needs at least two samples: one at 0 ms and one at the clip end",
        ));
    }
    if samples[0].offset_ms != 0 {
        return Err(Pan2Error::invalid(
            "the first action sample must be at 0 ms",
        ));
    }
    for pair in samples.windows(2) {
        if pair[1].offset_ms <= pair[0].offset_ms {
            return Err(Pan2Error::invalid(
                "action sample offsets must strictly increase",
            ));
        }
    }
    if samples.iter().any(|sample| sample.offset_ms % 100 != 0) {
        return Err(Pan2Error::invalid(
            "action sample offsets must be multiples of 100 ms",
        ));
    }
    let duration = samples[samples.len() - 1].offset_ms / 100;
    if !(MIN_DURATION_DS..=MAX_DURATION_DS).contains(&duration) {
        return Err(Pan2Error::invalid("clip duration must be 1 to 20 seconds"));
    }
    Ok(duration)
}

/// Camera tags for one sample. Translation is `[right, forward, up]` and
/// rotation is `[yaw-left, pitch-up, roll-clockwise]`, both as rates.
pub fn camera_tags(sample: &ActionSample) -> Vec<CameraTag> {
    let mut tags = Vec::new();
    let mut axis = |value: f32, positive: CameraTag, negative: CameraTag| {
        if value > CAMERA_DEADBAND {
            tags.push(positive);
        } else if value < -CAMERA_DEADBAND {
            tags.push(negative);
        }
    };
    axis(
        sample.translation[0],
        CameraTag::TrackRight,
        CameraTag::TrackLeft,
    );
    axis(
        sample.translation[1],
        CameraTag::DollyForward,
        CameraTag::DollyBackward,
    );
    axis(
        sample.translation[2],
        CameraTag::DollyUp,
        CameraTag::DollyDown,
    );
    axis(sample.rotation[0], CameraTag::PanLeft, CameraTag::PanRight);
    axis(sample.rotation[1], CameraTag::TiltUp, CameraTag::TiltDown);
    axis(
        sample.rotation[2],
        CameraTag::RollClockwise,
        CameraTag::RollCounterclockwise,
    );
    axis(
        sample.controls.get("zoom").copied().unwrap_or(0.0),
        CameraTag::ZoomIn,
        CameraTag::ZoomOut,
    );
    if sample.controls.get("unstable").copied().unwrap_or(0.0) > 0.5 {
        tags.push(CameraTag::Unstable);
    }
    if tags.is_empty() {
        tags.push(CameraTag::Static);
    }
    tags
}

/// `(start, end, tags)` per sample interval, with equal neighbours merged.
fn camera_intervals(
    samples: &[ActionSample],
) -> Result<Vec<(u32, u32, Vec<CameraTag>)>, Pan2Error> {
    let mut intervals: Vec<(u32, u32, Vec<CameraTag>)> = Vec::new();
    for pair in samples.windows(2) {
        let tags = camera_tags(&pair[0]);
        let (start, end) = (pair[0].offset_ms / 100, pair[1].offset_ms / 100);
        match intervals.last_mut() {
            Some(last) if last.2 == tags => last.1 = end,
            _ => intervals.push((start, end, tags)),
        }
    }
    Ok(intervals)
}

fn clip_camera(camera: &[(u32, u32, Vec<CameraTag>)], start: u32, end: u32) -> Vec<CameraInterval> {
    camera
        .iter()
        .filter(|(from, to, _)| *from < end && *to > start)
        .map(|(from, to, tags)| CameraInterval {
            time_range_sec: format_range((*from).max(start), (*to).min(end)),
            camera_motion: tags.clone(),
        })
        .collect()
}

/// Values of `prefix.<n>` for consecutive `n` starting at `first`.
fn numbered<'a>(
    metadata: &'a BTreeMap<String, String>,
    prefix: &str,
    first: usize,
) -> Result<Vec<&'a str>, Pan2Error> {
    let mut values = Vec::new();
    while let Some(value) = metadata.get(&format!("{prefix}.{}", first + values.len())) {
        values.push(value.as_str());
    }
    let declared = metadata
        .keys()
        .filter(|key| {
            key.strip_prefix(prefix)
                .and_then(|rest| rest.strip_prefix('.'))
                .is_some_and(|rest| rest.bytes().all(|b| b.is_ascii_digit()) && !rest.is_empty())
        })
        .count();
    if declared != values.len() {
        return Err(Pan2Error::invalid(format!(
            "`{prefix}.N` keys must be consecutive starting at {first}"
        )));
    }
    Ok(values)
}

fn subjects(metadata: &BTreeMap<String, String>) -> Result<Vec<Subject>, Pan2Error> {
    let values = numbered(metadata, "pan2.subject", 1)?;
    if values.len() > MAX_SUBJECTS {
        return Err(Pan2Error::invalid(format!(
            "at most {MAX_SUBJECTS} subjects are supported"
        )));
    }
    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let (name, attribute) = value.split_once('|').ok_or_else(|| {
                Pan2Error::invalid("`pan2.subject.N` must be `display name|attribute`")
            })?;
            Ok(Subject {
                subject_id: subject_id(index + 1),
                display_name: name.trim().to_owned(),
                subject_attribute: attribute.trim().to_owned(),
            })
        })
        .collect()
}

fn event_spans(
    metadata: &BTreeMap<String, String>,
    duration_ds: u32,
) -> Result<Vec<(u32, u32, String)>, Pan2Error> {
    let values = numbered(metadata, "pan2.event", 0)?;
    if values.is_empty() {
        return Ok(vec![(0, duration_ds, DEFAULT_EVENT.to_owned())]);
    }
    let mut spans = Vec::with_capacity(values.len());
    for value in values {
        let (range, prose) = value
            .split_once('|')
            .ok_or_else(|| Pan2Error::invalid("`pan2.event.N` must be `<a> to <b>|description`"))?;
        let (start, end) = parse_range(range.trim())?;
        spans.push((start, end, prose.trim().to_owned()));
    }
    if spans.last().map(|span| span.1) != Some(duration_ds) {
        return Err(Pan2Error::invalid(
            "the last event must end at the final action sample",
        ));
    }
    Ok(spans)
}

fn actions(
    metadata: &BTreeMap<String, String>,
    subjects: &[Subject],
) -> Result<Vec<(u32, u32, String)>, Pan2Error> {
    numbered(metadata, "pan2.act", 0)?
        .iter()
        .map(|value| {
            let mut parts = value.splitn(3, '|');
            let (Some(range), Some(subject), Some(text)) =
                (parts.next(), parts.next(), parts.next())
            else {
                return Err(Pan2Error::invalid(
                    "`pan2.act.N` must be `<a> to <b>|subject number|action`",
                ));
            };
            let (start, end) = parse_range(range.trim())?;
            let index: usize = subject
                .trim()
                .parse()
                .map_err(|_| Pan2Error::invalid("action subject must be a number"))?;
            let subject = index
                .checked_sub(1)
                .and_then(|zero_based| subjects.get(zero_based))
                .ok_or_else(|| Pan2Error::invalid("action names an undeclared subject"))?;
            Ok((
                start,
                end,
                format!("{} {}", subject.subject_id, text.trim()),
            ))
        })
        .collect()
}

fn image(metadata: &BTreeMap<String, String>) -> Result<Option<ImageRef>, Pan2Error> {
    let Some(file) = metadata.get("pan2.image") else {
        return Ok(None);
    };
    let sha256 = metadata
        .get("pan2.image.sha256")
        .ok_or_else(|| Pan2Error::invalid("`pan2.image` requires `pan2.image.sha256`"))?;
    crate::media::check_flat_name(file, &["png", "jpg", "jpeg"])?;
    crate::media::check_sha256(sha256)?;
    Ok(Some(ImageRef {
        file: file.clone(),
        sha256: sha256.clone(),
    }))
}
