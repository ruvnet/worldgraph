//! The PAN 2 structured world-state caption.
//!
//! PAN 2's diffusion backbone is conditioned on a JSON caption with seven keys
//! in a fixed order: style, lighting, viewpoint, tracked subjects, a still
//! description of the first frame, timed events, and a quality note. The shape
//! and the rules checked by [`Pan2Caption::validate`] follow the upstream
//! caption policy (`inference/pan-prompt-rewriter/system_prompt.md` in
//! `ifm-ai/PAN2`).
//!
//! Serde field order is the wire order, so do not reorder struct fields.

use serde::{Deserialize, Serialize};

use crate::Pan2Error;

/// Longest clip PAN 2 generates, in tenths of a second (20 s).
pub const MAX_DURATION_DS: u32 = 200;
/// Shortest clip this provider will request, in tenths of a second (1 s).
pub const MIN_DURATION_DS: u32 = 10;
/// Upstream ceiling for the first-frame paragraph and each event paragraph.
pub const MAX_PARAGRAPH_WORDS: usize = 200;
/// Tracked-subject limit used by this provider.
pub const MAX_SUBJECTS: usize = 8;
/// Structural byte budget for one serialized caption.
///
/// The text encoder accepts 1,536 tokens with a 1,480-token soft limit. This
/// crate does not run that tokenizer, so it enforces a byte budget instead.
/// The larger upstream example caption is 6,419 bytes and is within the token
/// limit, so 6,000 bytes is a cautious bound, not a measured one.
pub const MAX_CAPTION_BYTES: usize = 6_000;

/// Camera movement tags accepted by the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CameraTag {
    /// Camera does not move.
    Static,
    /// Rotate left about the vertical axis.
    PanLeft,
    /// Rotate right about the vertical axis.
    PanRight,
    /// Rotate upward.
    TiltUp,
    /// Rotate downward.
    TiltDown,
    /// Translate left.
    TrackLeft,
    /// Translate right.
    TrackRight,
    /// Translate forward.
    DollyForward,
    /// Translate backward.
    DollyBackward,
    /// Translate up.
    DollyUp,
    /// Translate down.
    DollyDown,
    /// Narrow the field of view.
    ZoomIn,
    /// Widen the field of view.
    ZoomOut,
    /// Roll clockwise about the view axis.
    RollClockwise,
    /// Roll counterclockwise about the view axis.
    RollCounterclockwise,
    /// Handheld or shaking camera.
    Unstable,
}

/// One tracked actor or independently moving object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Subject {
    /// `<|SubjectN|>`, sequential from 1.
    pub subject_id: String,
    /// Short name.
    pub display_name: String,
    /// Stable appearance.
    pub subject_attribute: String,
}

/// Camera tags active over one interval of an event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CameraInterval {
    /// `"<start> to <end>"` in seconds, at most one decimal.
    pub time_range_sec: String,
    /// Nonempty; `static` never combined with movement.
    pub camera_motion: Vec<CameraTag>,
}

/// One timed action bound to a subject.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContainedAction {
    /// `"<start> to <end>"`, inside the parent event.
    pub time_range_sec: String,
    /// Starts with the performer's subject id.
    pub action: String,
}

/// One phase of the single continuous shot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    /// Consecutive from zero.
    pub event_index: u32,
    /// `"<start> to <end>"`.
    pub time_range_sec: String,
    /// What visibly changes, at most 200 words.
    pub event_description: String,
    /// Covers the event contiguously.
    pub camera_motion: Vec<CameraInterval>,
    /// Timed subject actions; may be empty.
    pub contained_actions: Vec<ContainedAction>,
}

/// Intended finish.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Quality {
    /// Brief description of the intended rendering quality.
    pub video_quality: String,
    /// Requested on-screen text, or null.
    pub text_logos_overlays: Option<String>,
    /// Always null in a positive caption.
    pub artifacts: Option<String>,
}

/// A complete positive caption.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pan2Caption {
    /// Presentation or medium; states the continuous shot once.
    pub video_style: String,
    /// Scene-appropriate light and colour.
    pub lighting: String,
    /// Viewpoint and framing.
    pub perspective_view: String,
    /// Tracked subjects; may be empty.
    pub subjects_lifecycle: Vec<Subject>,
    /// Still description of the starting frame, at most 200 words.
    pub init_frame_visual_description: String,
    /// Contiguous phases covering zero through the duration.
    pub events: Vec<Event>,
    /// Intended finish.
    pub quality: Quality,
}

/// Formats tenths of a second the way upstream captions do: `0`, `2.2`, `13`.
pub fn format_ds(ds: u32) -> String {
    if ds.is_multiple_of(10) {
        (ds / 10).to_string()
    } else {
        format!("{}.{}", ds / 10, ds % 10)
    }
}

/// Formats a `"<start> to <end>"` range from tenths of a second.
pub fn format_range(start_ds: u32, end_ds: u32) -> String {
    format!("{} to {}", format_ds(start_ds), format_ds(end_ds))
}

/// Parses `"<start> to <end>"` into tenths of a second.
pub fn parse_range(range: &str) -> Result<(u32, u32), Pan2Error> {
    let (start, end) = range
        .split_once(" to ")
        .ok_or_else(|| Pan2Error::invalid(format!("time range `{range}` is not `<a> to <b>`")))?;
    Ok((parse_ds(start)?, parse_ds(end)?))
}

/// Parses seconds with at most one decimal place into tenths of a second.
pub fn parse_ds(text: &str) -> Result<u32, Pan2Error> {
    let bad = || Pan2Error::invalid(format!("`{text}` is not seconds with at most one decimal"));
    let (whole, tenth) = match text.split_once('.') {
        Some((whole, frac)) if frac.len() == 1 => (whole, frac.parse::<u32>().map_err(|_| bad())?),
        Some(_) => return Err(bad()),
        None => (text, 0),
    };
    if whole.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    let whole: u32 = whole.parse().map_err(|_| bad())?;
    whole
        .checked_mul(10)
        .and_then(|v| v.checked_add(tenth))
        .ok_or_else(bad)
}

fn words(text: &str) -> usize {
    text.split_whitespace().count()
}

fn nonempty(label: &str, text: &str) -> Result<(), Pan2Error> {
    if text.trim().is_empty() {
        return Err(Pan2Error::invalid(format!("{label} must not be empty")));
    }
    if text.chars().any(|c| c.is_control()) {
        return Err(Pan2Error::invalid(format!(
            "{label} contains a control character"
        )));
    }
    Ok(())
}

impl Pan2Caption {
    /// Total clip length in tenths of a second, taken from the last event.
    pub fn duration_ds(&self) -> Result<u32, Pan2Error> {
        let last = self
            .events
            .last()
            .ok_or_else(|| Pan2Error::invalid("caption has no events"))?;
        Ok(parse_range(&last.time_range_sec)?.1)
    }

    /// Checks the upstream schema rules that can be checked without the model.
    pub fn validate(&self) -> Result<(), Pan2Error> {
        nonempty("video_style", &self.video_style)?;
        nonempty("lighting", &self.lighting)?;
        nonempty("perspective_view", &self.perspective_view)?;
        nonempty(
            "init_frame_visual_description",
            &self.init_frame_visual_description,
        )?;
        nonempty("quality.video_quality", &self.quality.video_quality)?;
        if self.quality.artifacts.is_some() {
            return Err(Pan2Error::invalid("quality.artifacts must be null"));
        }
        if words(&self.init_frame_visual_description) > MAX_PARAGRAPH_WORDS {
            return Err(Pan2Error::invalid(
                "init_frame_visual_description exceeds 200 words",
            ));
        }
        if self.init_frame_visual_description.contains("<|Subject") {
            return Err(Pan2Error::invalid(
                "init_frame_visual_description must not contain subject ids",
            ));
        }
        if self.subjects_lifecycle.len() > MAX_SUBJECTS {
            return Err(Pan2Error::invalid(format!(
                "at most {MAX_SUBJECTS} subjects are supported"
            )));
        }
        for (index, subject) in self.subjects_lifecycle.iter().enumerate() {
            if subject.subject_id != subject_id(index + 1) {
                return Err(Pan2Error::invalid("subject ids must be sequential from 1"));
            }
            nonempty("subject display_name", &subject.display_name)?;
            nonempty("subject_attribute", &subject.subject_attribute)?;
        }
        if self.events.is_empty() {
            return Err(Pan2Error::invalid("caption has no events"));
        }
        let mut cursor = 0;
        for (index, event) in self.events.iter().enumerate() {
            if event.event_index as usize != index {
                return Err(Pan2Error::invalid(
                    "event indices must be consecutive from 0",
                ));
            }
            let (start, end) = parse_range(&event.time_range_sec)?;
            if start != cursor || end <= start {
                return Err(Pan2Error::invalid(
                    "events must cover the clip contiguously from zero",
                ));
            }
            nonempty("event_description", &event.event_description)?;
            if words(&event.event_description) > MAX_PARAGRAPH_WORDS {
                return Err(Pan2Error::invalid("event_description exceeds 200 words"));
            }
            if event.event_description.contains("<|Subject") {
                return Err(Pan2Error::invalid(
                    "event_description must not contain subject ids",
                ));
            }
            self.validate_camera(event, start, end)?;
            self.validate_actions(event, start, end)?;
            cursor = end;
        }
        if !(MIN_DURATION_DS..=MAX_DURATION_DS).contains(&cursor) {
            return Err(Pan2Error::invalid("clip duration must be 1 to 20 seconds"));
        }
        Ok(())
    }

    fn validate_camera(&self, event: &Event, start: u32, end: u32) -> Result<(), Pan2Error> {
        let mut cursor = start;
        for interval in &event.camera_motion {
            let (from, to) = parse_range(&interval.time_range_sec)?;
            if from != cursor || to <= from {
                return Err(Pan2Error::invalid(
                    "camera intervals must cover their event contiguously",
                ));
            }
            let tags = &interval.camera_motion;
            let mut unique = tags.clone();
            unique.sort();
            unique.dedup();
            if tags.is_empty() || unique.len() != tags.len() {
                return Err(Pan2Error::invalid(
                    "camera tags must be nonempty and unique per interval",
                ));
            }
            if tags.len() > 1 && tags.contains(&CameraTag::Static) {
                return Err(Pan2Error::invalid(
                    "`static` cannot be combined with movement",
                ));
            }
            cursor = to;
        }
        if cursor != end {
            return Err(Pan2Error::invalid(
                "camera intervals must cover their event contiguously",
            ));
        }
        Ok(())
    }

    fn validate_actions(&self, event: &Event, start: u32, end: u32) -> Result<(), Pan2Error> {
        for action in &event.contained_actions {
            let (from, to) = parse_range(&action.time_range_sec)?;
            if from < start || to > end || to <= from {
                return Err(Pan2Error::invalid(
                    "contained action must lie inside its event with positive length",
                ));
            }
            nonempty("action", &action.action)?;
            let registered = self
                .subjects_lifecycle
                .iter()
                .any(|subject| action.action.starts_with(&subject.subject_id));
            if !registered {
                return Err(Pan2Error::invalid(
                    "action must begin with a registered subject id",
                ));
            }
        }
        Ok(())
    }

    /// Serializes the caption compactly, enforcing [`MAX_CAPTION_BYTES`].
    ///
    /// The returned string is what PAN 2's text encoder receives as
    /// `refined_prompt`.
    pub fn to_prompt_string(&self) -> Result<String, Pan2Error> {
        self.validate()?;
        let text = serde_json::to_string(self)?;
        if text.len() > MAX_CAPTION_BYTES {
            return Err(Pan2Error::CaptionTooLong {
                bytes: text.len(),
                budget: MAX_CAPTION_BYTES,
            });
        }
        Ok(text)
    }
}

/// `<|SubjectN|>` for a one-based index.
pub fn subject_id(index: usize) -> String {
    format!("<|Subject{index}|>")
}

/// Frame count PAN 2 renders for a duration: `4 * ceil(seconds * fps / 4) + 1`.
pub fn frames_for(duration_ds: u32, fps: u32) -> u32 {
    let frames_times_ten = duration_ds * fps;
    // ceil(duration_s * fps / 4) with duration in tenths of a second.
    4 * frames_times_ten.div_ceil(40) + 1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caption() -> Pan2Caption {
        Pan2Caption {
            video_style: "Realistic footage in one uninterrupted continuous shot.".into(),
            lighting: "Even overhead light.".into(),
            perspective_view: "Eye-level static view.".into(),
            subjects_lifecycle: vec![Subject {
                subject_id: subject_id(1),
                display_name: "Robot arm".into(),
                subject_attribute: "White six-axis arm on a steel bench.".into(),
            }],
            init_frame_visual_description: "A white robot arm rests above a steel bench.".into(),
            events: vec![Event {
                event_index: 0,
                time_range_sec: "0 to 5".into(),
                event_description: "The arm lowers and lifts a small grey block.".into(),
                camera_motion: vec![CameraInterval {
                    time_range_sec: "0 to 5".into(),
                    camera_motion: vec![CameraTag::Static],
                }],
                contained_actions: vec![ContainedAction {
                    time_range_sec: "0.5 to 4".into(),
                    action: format!("{} lowers, grips the block and lifts it.", subject_id(1)),
                }],
            }],
            quality: Quality {
                video_quality: "Resolved machine surfaces.".into(),
                text_logos_overlays: None,
                artifacts: None,
            },
        }
    }

    #[test]
    fn times_round_trip_in_upstream_format() {
        assert_eq!(format_range(0, 22), "0 to 2.2");
        assert_eq!(format_range(15, 200), "1.5 to 20");
        assert_eq!(parse_range("0.3 to 13").unwrap(), (3, 130));
        assert!(parse_ds("1.25").is_err());
        assert!(parse_ds("-1").is_err());
        assert!(parse_ds("").is_err());
        assert!(parse_range("0-5").is_err());
    }

    #[test]
    fn frame_count_matches_upstream_formula() {
        // 4 * ceil(d * 24 / 4) + 1
        assert_eq!(frames_for(100, 24), 241);
        assert_eq!(frames_for(200, 24), 481);
        assert_eq!(frames_for(50, 24), 121);
        assert_eq!(frames_for(22, 24), 4 * 14 + 1);
    }

    #[test]
    fn valid_caption_serializes_in_the_upstream_key_order() {
        let text = caption().to_prompt_string().unwrap();
        let keys = [
            "\"video_style\"",
            "\"lighting\"",
            "\"perspective_view\"",
            "\"subjects_lifecycle\"",
            "\"init_frame_visual_description\"",
            "\"events\"",
            "\"quality\"",
        ];
        let positions: Vec<usize> = keys.iter().map(|key| text.find(key).unwrap()).collect();
        assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(text.contains("\"camera_motion\":[\"static\"]"));
        assert!(text.contains("\"artifacts\":null"));
    }

    #[test]
    fn gaps_overlaps_and_bad_tags_are_rejected() {
        let mut gap = caption();
        gap.events[0].time_range_sec = "0.5 to 5".into();
        assert!(gap.validate().is_err());

        let mut camera_short = caption();
        camera_short.events[0].camera_motion[0].time_range_sec = "0 to 4".into();
        assert!(camera_short.validate().is_err());

        let mut mixed = caption();
        mixed.events[0].camera_motion[0].camera_motion =
            vec![CameraTag::Static, CameraTag::PanLeft];
        assert!(mixed.validate().is_err());

        let mut outside = caption();
        outside.events[0].contained_actions[0].time_range_sec = "4 to 6".into();
        assert!(outside.validate().is_err());

        let mut unknown_actor = caption();
        unknown_actor.events[0].contained_actions[0].action = "<|Subject2|> moves.".into();
        assert!(unknown_actor.validate().is_err());

        let mut too_long = caption();
        too_long.events[0].time_range_sec = "0 to 20.1".into();
        too_long.events[0].camera_motion[0].time_range_sec = "0 to 20.1".into();
        assert!(too_long.validate().is_err());
    }

    #[test]
    fn oversized_caption_reports_the_byte_budget() {
        let mut big = caption();
        // 199 words of 40 bytes: within the word limit, over the byte budget.
        big.init_frame_visual_description = vec!["a".repeat(39); 199].join(" ");
        assert!(big.validate().is_ok());
        match big.to_prompt_string() {
            Err(Pan2Error::CaptionTooLong { bytes, budget }) => {
                assert!(bytes > budget);
                assert_eq!(budget, MAX_CAPTION_BYTES);
            }
            other => panic!("expected CaptionTooLong, got {other:?}"),
        }
    }
}
