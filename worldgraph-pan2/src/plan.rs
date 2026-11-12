//! A typed rollout plan that lowers to the ADR-204 session inputs.
//!
//! [`RolloutPlan`] is the ergonomic way to ask PAN 2 "what happens next in
//! this scene if these things occur". It is plain serde data, so plans can be
//! kept as JSON files, and [`RolloutPlan::into_inputs`] produces the
//! [`SceneSeed`] and [`ActionChunk`] that [`crate::compile::compile`] reads.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use wifi_densepose_worldmodel::{
    ActionChunk, ActionSample, PrivacyDecision, RetentionPolicy, ScenePrimitive, SceneSeed,
};

use crate::caption::format_range;
use crate::compile::ImageRef;
use crate::media::sha256_hex;
use crate::Pan2Error;

/// A tracked actor or independently moving object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanSubject {
    /// Short name, for example `Delivery robot`.
    pub name: String,
    /// Stable appearance.
    pub attribute: String,
}

/// One phase of the clip.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanEvent {
    /// Phase end in seconds; phases run back to back from zero.
    pub until_sec: f64,
    /// What visibly changes during the phase.
    pub description: String,
}

/// One timed action by a subject.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanAction {
    /// Start in seconds.
    pub from_sec: f64,
    /// End in seconds.
    pub to_sec: f64,
    /// One-based index into [`RolloutPlan::subjects`].
    pub subject: usize,
    /// What the subject does, without the subject's name.
    pub action: String,
}

/// Camera motion held from `at_sec` until the next key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CameraKey {
    /// Start of this motion in seconds.
    pub at_sec: f64,
    /// `[right, forward, up]` rate.
    #[serde(default)]
    pub translation: [f32; 3],
    /// `[yaw-left, pitch-up, roll-clockwise]` rate.
    #[serde(default)]
    pub rotation: [f32; 3],
    /// Positive zooms in, negative zooms out.
    #[serde(default)]
    pub zoom: f32,
}

/// A complete request for one simulated clip.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RolloutPlan {
    /// Display name of the rollout.
    pub name: String,
    /// Hash of the authorized graph snapshot this plan was projected from.
    pub source_snapshot_hash: String,
    /// Stream epoch of that snapshot.
    pub source_stream_epoch: u64,
    /// Deterministic generation seed.
    pub generation_seed: u64,
    /// Identifier of the authorized projection (not a user id).
    pub projection_id: String,
    /// Whether sending this projection to a remote GPU host was approved.
    pub hosted_processing_approved: bool,
    /// Fields or nodes removed before this plan was built.
    #[serde(default)]
    pub redactions_applied: u32,
    /// Clip length in seconds, 1 to 20, at most one decimal place.
    pub duration_sec: f64,
    /// Still description of the starting view.
    pub first_frame: String,
    /// Sanitized scene geometry appended to the description as a layout sentence.
    #[serde(default)]
    pub scene: Vec<ScenePrimitive>,
    /// Presentation or medium. A default is used when absent.
    #[serde(default)]
    pub style: Option<String>,
    /// Light and colour. A default is used when absent.
    #[serde(default)]
    pub lighting: Option<String>,
    /// Viewpoint and framing. A default is used when absent.
    #[serde(default)]
    pub view: Option<String>,
    /// Tracked subjects.
    #[serde(default)]
    pub subjects: Vec<PlanSubject>,
    /// Phases; when empty the clip is a single phase.
    #[serde(default)]
    pub events: Vec<PlanEvent>,
    /// Timed subject actions.
    #[serde(default)]
    pub actions: Vec<PlanAction>,
    /// Camera keys; when empty the camera is static.
    #[serde(default)]
    pub camera: Vec<CameraKey>,
    /// Conditioning image for image-to-video.
    #[serde(default)]
    pub image: Option<ImageRef>,
}

/// Converts seconds with at most one decimal place to tenths of a second.
fn to_ds(label: &str, seconds: f64) -> Result<u32, Pan2Error> {
    let scaled = seconds * 10.0;
    let rounded = scaled.round();
    if !seconds.is_finite() || seconds < 0.0 || (scaled - rounded).abs() > 1e-6 || rounded > 1e6 {
        return Err(Pan2Error::invalid(format!(
            "{label} must be non-negative seconds with at most one decimal place"
        )));
    }
    Ok(rounded as u32)
}

fn field(label: &str, text: &str) -> Result<String, Pan2Error> {
    let text = text.trim();
    if text.is_empty() || text.contains('|') || text.chars().any(|c| c.is_control()) {
        return Err(Pan2Error::invalid(format!(
            "{label} must be nonempty text without `|` or control characters"
        )));
    }
    Ok(text.to_owned())
}

impl RolloutPlan {
    /// Parses a plan from JSON, rejecting unknown fields.
    pub fn from_json(bytes: &[u8]) -> Result<Self, Pan2Error> {
        Ok(serde_json::from_slice(bytes)?)
    }

    /// Lowers the plan to the session inputs carried by the sidecar protocol.
    ///
    /// `epoch` and `sequence` position the action in a model session. The
    /// action hash is the SHA-256 of the canonical JSON of the samples and
    /// metadata, so equal plans hash equally.
    pub fn into_inputs(
        &self,
        epoch: u64,
        sequence: u64,
    ) -> Result<(SceneSeed, ActionChunk), Pan2Error> {
        let duration = to_ds("duration_sec", self.duration_sec)?;

        let mut seed_metadata = BTreeMap::new();
        seed_metadata.insert("pan2.name".to_owned(), field("name", &self.name)?);
        for (key, value) in [
            ("pan2.style", &self.style),
            ("pan2.lighting", &self.lighting),
            ("pan2.view", &self.view),
        ] {
            if let Some(text) = value {
                seed_metadata.insert(key.to_owned(), field(key, text)?);
            }
        }
        for (index, subject) in self.subjects.iter().enumerate() {
            seed_metadata.insert(
                format!("pan2.subject.{}", index + 1),
                format!(
                    "{}|{}",
                    field("subject name", &subject.name)?,
                    field("subject attribute", &subject.attribute)?
                ),
            );
        }
        if let Some(image) = &self.image {
            seed_metadata.insert("pan2.image".to_owned(), image.file.clone());
            seed_metadata.insert("pan2.image.sha256".to_owned(), image.sha256.clone());
        }

        let mut action_metadata = BTreeMap::new();
        let mut cursor = 0;
        for (index, event) in self.events.iter().enumerate() {
            let end = to_ds("event until_sec", event.until_sec)?;
            action_metadata.insert(
                format!("pan2.event.{index}"),
                format!(
                    "{}|{}",
                    format_range(cursor, end),
                    field("event description", &event.description)?
                ),
            );
            cursor = end;
        }
        for (index, action) in self.actions.iter().enumerate() {
            action_metadata.insert(
                format!("pan2.act.{index}"),
                format!(
                    "{}|{}|{}",
                    format_range(
                        to_ds("action from_sec", action.from_sec)?,
                        to_ds("action to_sec", action.to_sec)?
                    ),
                    action.subject,
                    field("action", &action.action)?
                ),
            );
        }

        let mut samples = Vec::with_capacity(self.camera.len() + 2);
        for key in &self.camera {
            let mut controls = BTreeMap::new();
            if key.zoom != 0.0 {
                controls.insert("zoom".to_owned(), key.zoom);
            }
            samples.push(ActionSample {
                offset_ms: to_ds("camera at_sec", key.at_sec)? * 100,
                translation: key.translation,
                rotation: key.rotation,
                controls,
            });
        }
        if samples.first().map(|sample| sample.offset_ms) != Some(0) {
            samples.insert(0, still_sample(0));
        }
        // The closing sample only marks the clip end; its motion is not used.
        samples.push(still_sample(duration * 100));

        let action_hash = sha256_hex(&serde_json::to_vec(&(&samples, &action_metadata))?);
        let seed = SceneSeed {
            source_snapshot_hash: self.source_snapshot_hash.clone(),
            source_stream_epoch: self.source_stream_epoch,
            generation_seed: self.generation_seed,
            prompt: Some(self.first_frame.trim().to_owned()),
            scene: self.scene.clone(),
            privacy: PrivacyDecision {
                projection_id: self.projection_id.clone(),
                hosted_processing_approved: self.hosted_processing_approved,
                redactions_applied: self.redactions_applied,
                retention: RetentionPolicy::PolicyBound,
            },
            metadata: seed_metadata,
        };
        let action = ActionChunk {
            epoch,
            sequence,
            samples,
            action_hash,
            metadata: action_metadata,
        };
        Ok((seed, action))
    }
}

fn still_sample(offset_ms: u32) -> ActionSample {
    ActionSample {
        offset_ms,
        translation: [0.0; 3],
        rotation: [0.0; 3],
        controls: BTreeMap::new(),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::caption::CameraTag;
    use crate::compile::{compile, Task};

    pub(crate) fn door_plan() -> RolloutPlan {
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

    #[test]
    fn plan_lowers_and_compiles_to_a_valid_caption() {
        let (seed, action) = door_plan().into_inputs(0, 0).unwrap();
        assert_eq!(action.samples.len(), 3);
        assert_eq!(action.samples.last().unwrap().offset_ms, 5_000);
        let compiled = compile(&seed, &action).unwrap();
        assert_eq!(compiled.task, Task::T2v);
        assert_eq!(compiled.duration_ds, 50);
        assert_eq!(compiled.frames, 121);
        let caption = &compiled.caption;
        assert_eq!(caption.events.len(), 2);
        assert_eq!(caption.events[0].time_range_sec, "0 to 1");
        // Camera is static until 2 s, then dollies forward; split at the event boundary.
        assert_eq!(caption.events[1].camera_motion.len(), 2);
        assert_eq!(caption.events[1].camera_motion[0].time_range_sec, "1 to 2");
        assert_eq!(
            caption.events[1].camera_motion[0].camera_motion,
            vec![CameraTag::Static]
        );
        assert_eq!(
            caption.events[1].camera_motion[1].camera_motion,
            vec![CameraTag::DollyForward]
        );
        assert_eq!(
            caption.events[1].contained_actions[0].action,
            "<|Subject1|> swings inward on its hinges until fully open."
        );
        assert!(caption
            .init_frame_visual_description
            .contains("a workbench about 1.6 m wide to the left in the foreground"));
        assert!(caption
            .init_frame_visual_description
            .contains("a rf door about 1.0 m wide to the right in the background"));
    }

    #[test]
    fn equal_plans_hash_equally_and_changes_change_the_hash() {
        let (_, first) = door_plan().into_inputs(0, 0).unwrap();
        let (_, second) = door_plan().into_inputs(0, 0).unwrap();
        assert_eq!(first.action_hash, second.action_hash);
        let mut changed = door_plan();
        changed.actions[0].to_sec = 4.0;
        let (_, third) = changed.into_inputs(0, 0).unwrap();
        assert_ne!(first.action_hash, third.action_hash);
    }

    #[test]
    fn bad_times_separators_and_unknown_fields_are_rejected() {
        let mut fractional = door_plan();
        fractional.duration_sec = 5.25;
        assert!(fractional.into_inputs(0, 0).is_err());

        let mut piped = door_plan();
        piped.subjects[0].name = "Door|hack".into();
        assert!(piped.into_inputs(0, 0).is_err());

        let mut crossing = door_plan();
        crossing.actions[0].from_sec = 0.5;
        let (seed, action) = crossing.into_inputs(0, 0).unwrap();
        assert!(compile(&seed, &action).is_err());

        let mut short_events = door_plan();
        short_events.events[1].until_sec = 4.0;
        let (seed, action) = short_events.into_inputs(0, 0).unwrap();
        assert!(compile(&seed, &action).is_err());

        let json = serde_json::to_string(&door_plan()).unwrap();
        let with_extra = json.replacen('{', "{\"raw_csi\":[1],", 1);
        assert!(RolloutPlan::from_json(with_extra.as_bytes()).is_err());
        assert_eq!(
            RolloutPlan::from_json(json.as_bytes()).unwrap(),
            door_plan()
        );
    }

    #[test]
    fn an_image_makes_the_task_image_to_video() {
        let mut plan = door_plan();
        plan.image = Some(ImageRef {
            file: "first.png".into(),
            sha256: "a".repeat(64),
        });
        let (seed, action) = plan.into_inputs(0, 0).unwrap();
        let compiled = compile(&seed, &action).unwrap();
        assert_eq!(compiled.task, Task::I2v);
        let record = compiled.prompt_record("clip.mp4", Some("/media/images/first.png"));
        assert_eq!(record["type"], "i2v");
        assert_eq!(record["image_path"], "/media/images/first.png");
        assert_eq!(record["duration_sec"], 5.0);

        plan.image.as_mut().unwrap().file = "../first.png".into();
        let (seed, action) = plan.into_inputs(0, 0).unwrap();
        assert!(compile(&seed, &action).is_err());
    }
}
