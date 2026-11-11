//! Cognitum Spaces → rollout plan.
//!
//! Turns the records the Spaces API returns for one space
//! (`GET /v1/spatial/{sites,spaces,zones,entities,events}`) into a
//! [`RolloutPlan`]. The Spaces schema has no geometry fields, so layout and
//! prose come from each record's free-form `attributes`:
//!
//! | Record | Attribute | Use |
//! | --- | --- | --- |
//! | space | `description`, `lighting`, `view` | first frame, light, viewpoint |
//! | zone, entity | `centerM`, `sizeM` (`[x, y, z]` metres), `class` | layout sentence |
//! | entity | `appearance` | makes the entity a tracked subject |
//! | event | `entityId`, `narrative`, `action` | timed phase and subject action |
//!
//! Events are ordered by `eventSequence` and share the clip evenly. Their
//! real timestamps are not used: a rollout dramatizes the sequence, it does
//! not replay it.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wifi_densepose_worldmodel::ScenePrimitive;

use crate::media::sha256_hex;
use crate::plan::{PlanAction, PlanEvent, PlanSubject, RolloutPlan};
use crate::spaces::is_spaces_id;
use crate::Pan2Error;

/// Snapshot format identifier.
pub const SNAPSHOT_FORMAT: &str = "cognitum.spaces.snapshot";

/// One Spaces record as returned in a response's `data`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpacesRecord {
    /// Resource id.
    pub id: String,
    /// Display name (sites, spaces, zones, entities).
    #[serde(default)]
    pub name: Option<String>,
    /// `sensor`, `person`, `object` or `track` (entities).
    #[serde(default)]
    pub entity_type: Option<String>,
    /// Must be `anonymous` for person and track entities.
    #[serde(default)]
    pub identity_mode: Option<String>,
    /// Event type (events).
    #[serde(default)]
    pub event_type: Option<String>,
    /// Zone the record belongs to.
    #[serde(default)]
    pub zone_id: Option<String>,
    /// Writer-assigned order (events).
    #[serde(default)]
    pub event_sequence: Option<u64>,
    /// Free-form attributes.
    #[serde(default)]
    pub attributes: serde_json::Map<String, Value>,
    /// Every other field the API returned; kept so the hash covers it.
    #[serde(flatten)]
    pub other: serde_json::Map<String, Value>,
}

/// The records of one space, as fetched from the Spaces API.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpacesSnapshot {
    /// Must be [`SNAPSHOT_FORMAT`].
    pub format: String,
    /// Must be 1.
    pub version: u32,
    /// The site record.
    pub site: SpacesRecord,
    /// The space record.
    pub space: SpacesRecord,
    /// Zones of the space.
    #[serde(default)]
    pub zones: Vec<SpacesRecord>,
    /// Entities of the space.
    #[serde(default)]
    pub entities: Vec<SpacesRecord>,
    /// Events to dramatize.
    #[serde(default)]
    pub events: Vec<SpacesRecord>,
}

/// Choices that are not in the Spaces data.
#[derive(Debug, Clone, PartialEq)]
pub struct PlanOptions {
    /// Clip length in whole seconds, 1 to 20.
    pub duration_sec: u32,
    /// Deterministic generation seed.
    pub generation_seed: u64,
    /// Whether sending this projection to a remote GPU host was approved.
    pub hosted_processing_approved: bool,
}

fn text<'a>(record: &'a SpacesRecord, key: &str) -> Option<&'a str> {
    record
        .attributes
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn vec3(record: &SpacesRecord, key: &str) -> Option<[f32; 3]> {
    let values = record.attributes.get(key)?.as_array()?;
    let mut out = [0.0; 3];
    if values.len() != 3 {
        return None;
    }
    for (slot, value) in out.iter_mut().zip(values) {
        *slot = value.as_f64().filter(|v| v.is_finite())? as f32;
    }
    Some(out)
}

fn name(record: &SpacesRecord) -> &str {
    record.name.as_deref().unwrap_or(&record.id)
}

fn class(record: &SpacesRecord) -> String {
    let source = text(record, "class").unwrap_or_else(|| name(record));
    let mut out = String::new();
    for c in source.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('_') && !out.is_empty() {
            out.push('_');
        }
    }
    out.trim_end_matches('_').to_owned()
}

fn words(event_type: &str) -> String {
    event_type.replace(['.', '_', '-', ':'], " ")
}

impl SpacesSnapshot {
    /// Parses a snapshot and checks its header and ids.
    pub fn from_json(bytes: &[u8]) -> Result<Self, Pan2Error> {
        let snapshot: Self = serde_json::from_slice(bytes)?;
        if snapshot.format != SNAPSHOT_FORMAT || snapshot.version != 1 {
            return Err(Pan2Error::invalid(format!(
                "expected {SNAPSHOT_FORMAT} version 1"
            )));
        }
        let records = [&snapshot.site, &snapshot.space].into_iter();
        for record in records
            .chain(&snapshot.zones)
            .chain(&snapshot.entities)
            .chain(&snapshot.events)
        {
            if !is_spaces_id(&record.id) {
                return Err(Pan2Error::invalid(format!(
                    "`{}` is not a Spaces id",
                    record.id
                )));
            }
        }
        Ok(snapshot)
    }

    /// SHA-256 of the snapshot's canonical JSON, as `sha256:<hex>`.
    pub fn hash(&self) -> Result<String, Pan2Error> {
        // serde_json maps are ordered, so re-serializing through Value is canonical.
        let value = serde_json::to_value(self)?;
        Ok(format!(
            "sha256:{}",
            sha256_hex(&serde_json::to_vec(&value)?)
        ))
    }

    /// Builds the plan for one clip.
    pub fn to_plan(&self, options: &PlanOptions) -> Result<RolloutPlan, Pan2Error> {
        if !(1..=20).contains(&options.duration_sec) {
            return Err(Pan2Error::invalid("duration must be 1 to 20 seconds"));
        }
        let mut redactions = 0;
        let mut scene = Vec::new();
        for record in self.zones.iter().chain(&self.entities) {
            if let (Some(center_m), Some(size_m)) = (vec3(record, "centerM"), vec3(record, "sizeM"))
            {
                scene.push(ScenePrimitive::Box {
                    center_m,
                    size_m,
                    class: class(record),
                });
            }
        }

        // Subjects: entities with an appearance. People stay anonymous.
        let mut subjects = Vec::new();
        let mut subject_ids = Vec::new();
        for entity in &self.entities {
            let kind = entity.entity_type.as_deref().unwrap_or("");
            let Some(appearance) = text(entity, "appearance") else {
                continue;
            };
            if matches!(kind, "person" | "track")
                && entity.identity_mode.as_deref() != Some("anonymous")
            {
                redactions += 1;
                continue;
            }
            subjects.push(PlanSubject {
                name: name(entity).to_owned(),
                attribute: appearance.to_owned(),
            });
            subject_ids.push(entity.id.as_str());
        }

        let mut ordered: Vec<&SpacesRecord> = self.events.iter().collect();
        ordered.sort_by_key(|event| event.event_sequence.unwrap_or(u64::MAX));
        if ordered.is_empty() {
            return Err(Pan2Error::invalid(
                "the snapshot has no events to dramatize",
            ));
        }
        let total_ds = options.duration_sec * 10;
        let count = ordered.len() as u32;
        if total_ds / count < 10 {
            return Err(Pan2Error::invalid(
                "each event needs at least one second of the clip",
            ));
        }
        let mut events = Vec::new();
        let mut actions = Vec::new();
        let mut start_ds = 0;
        for (index, event) in ordered.iter().enumerate() {
            let end_ds = total_ds * (index as u32 + 1) / count;
            let kind = words(event.event_type.as_deref().unwrap_or("event"));
            let zone = event
                .zone_id
                .as_deref()
                .and_then(|id| self.zones.iter().find(|zone| zone.id == id))
                .map(name);
            let subject = text(event, "entityId")
                .and_then(|id| subject_ids.iter().position(|known| *known == id));
            let description = match (text(event, "narrative"), subject, zone) {
                (Some(narrative), _, _) => narrative.to_owned(),
                (None, Some(subject), Some(zone)) => {
                    format!("{}: {kind} in the {zone}.", subjects[subject].name)
                }
                (None, _, Some(zone)) => format!("A {kind} happens in the {zone}."),
                (None, _, None) => format!("A {kind} happens."),
            };
            events.push(PlanEvent {
                until_sec: f64::from(end_ds) / 10.0,
                description,
            });
            if let Some(subject) = subject {
                let action =
                    text(event, "action")
                        .map(str::to_owned)
                        .unwrap_or_else(|| match zone {
                            Some(zone) => format!("takes part in the {kind} in the {zone}."),
                            None => format!("takes part in the {kind}."),
                        });
                actions.push(PlanAction {
                    from_sec: f64::from(start_ds) / 10.0,
                    to_sec: f64::from(end_ds) / 10.0,
                    subject: subject + 1,
                    action,
                });
            }
            start_ds = end_ds;
        }

        let first_frame = match text(&self.space, "description") {
            Some(description) => description.to_owned(),
            None => format!(
                "The {} at {}, with nobody moving yet.",
                name(&self.space),
                name(&self.site)
            ),
        };
        Ok(RolloutPlan {
            name: format!("{} · {}", name(&self.site), name(&self.space)),
            source_snapshot_hash: self.hash()?,
            source_stream_epoch: ordered
                .last()
                .and_then(|event| event.event_sequence)
                .unwrap_or(0),
            generation_seed: options.generation_seed,
            projection_id: format!("spaces:{}:{}", self.site.id, self.space.id),
            hosted_processing_approved: options.hosted_processing_approved,
            redactions_applied: redactions,
            duration_sec: f64::from(options.duration_sec),
            first_frame,
            scene,
            style: None,
            lighting: text(&self.space, "lighting").map(str::to_owned),
            view: text(&self.space, "view").map(str::to_owned),
            subjects,
            events,
            actions,
            camera: Vec::new(),
            image: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compile::compile;

    fn snapshot() -> SpacesSnapshot {
        SpacesSnapshot::from_json(include_bytes!("../examples/spaces/warehouse-amr.json")).unwrap()
    }

    fn options() -> PlanOptions {
        PlanOptions {
            duration_sec: 20,
            generation_seed: 7,
            hosted_processing_approved: true,
        }
    }

    #[test]
    fn a_spaces_snapshot_becomes_a_valid_twenty_second_caption() {
        let snapshot = snapshot();
        let plan = snapshot.to_plan(&options()).unwrap();
        assert_eq!(plan.duration_sec, 20.0);
        assert_eq!(plan.events.len(), snapshot.events.len());
        assert_eq!(plan.events.last().unwrap().until_sec, 20.0);
        assert!(plan.source_snapshot_hash.starts_with("sha256:"));
        assert_eq!(
            plan.projection_id,
            format!("spaces:{}:{}", snapshot.site.id, snapshot.space.id)
        );
        let (seed, action) = plan.into_inputs(0, 0).unwrap();
        let compiled = compile(&seed, &action).unwrap();
        assert_eq!(compiled.frames, 481);
    }

    #[test]
    fn the_hash_follows_the_data_and_events_follow_their_sequence() {
        let mut snapshot = snapshot();
        let before = snapshot.to_plan(&options()).unwrap();
        snapshot.events.reverse();
        let reordered = snapshot.to_plan(&options()).unwrap();
        assert_eq!(before.events, reordered.events);
        snapshot.events[0]
            .attributes
            .insert("narrative".into(), "Something else happens.".into());
        assert_ne!(snapshot.hash().unwrap(), before.source_snapshot_hash);
    }

    #[test]
    fn identified_people_are_dropped_and_bad_input_is_rejected() {
        let mut snapshot = snapshot();
        let subjects = snapshot.to_plan(&options()).unwrap().subjects.len();
        snapshot.entities[0].entity_type = Some("person".into());
        snapshot.entities[0].identity_mode = Some("named".into());
        let plan = snapshot.to_plan(&options()).unwrap();
        assert_eq!(plan.subjects.len(), subjects - 1);
        assert_eq!(plan.redactions_applied, 1);

        let mut short = options();
        short.duration_sec = 2;
        assert!(snapshot.to_plan(&short).is_err());
        snapshot.events.clear();
        assert!(snapshot.to_plan(&options()).is_err());
        assert!(SpacesSnapshot::from_json(br#"{"format":"x","version":1}"#).is_err());
    }
}
