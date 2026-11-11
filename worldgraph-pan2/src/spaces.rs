//! Cognitum Spaces projection of a rollout.
//!
//! Spaces stores small semantic JSON, never media. A rollout is published as
//! one `POST /v1/spatial/simulations` body (ADR-107): a labelled, zero-confidence
//! prediction that carries the clip's hash and a pointer to it plus the model
//! provenance. It is never an event, so it cannot be mistaken for an
//! observation. The clip itself stays wherever the operator hosts it.
//!
//! [`validate_simulation`] mirrors the limits enforced by the Spaces handler
//! (`functions/api/src/api/spatial-resources.ts`, `spatial-simulations.ts` in
//! `cognitum-one/api`, ADR-107 branch `feat/spaces-simulated-rollouts`, not yet
//! deployed) so a payload is checked before it leaves the process. The server
//! remains the authority; this is a local preflight, not a guarantee.

use serde_json::{json, Map, Value};
use wifi_densepose_worldmodel::SimulatedFrameEnvelope;

use crate::Pan2Error;

/// `simulationType` used for PAN 2 video rollouts.
pub const ROLLOUT_SIMULATION_TYPE: &str = "video.rollout";
/// Largest request body the Spaces handler accepts.
pub const MAX_BODY_BYTES: usize = 64 * 1024;
/// Largest safe integer in JavaScript; `eventSequence` must not exceed it.
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

const WRITE_FIELDS: &[&str] = &[
    "workspaceId",
    "id",
    "messageId",
    "eventSequence",
    "observedAt",
    "expiresAt",
    "privacy",
    "name",
    "siteId",
    "buildingId",
    "floorId",
    "spaceId",
    "zoneId",
    "entityType",
    "identityMode",
    "eventType",
    "alertType",
    "severity",
    "status",
    "relatedEventIds",
    "confidence",
    "attributes",
    "provenance",
    "placement",
    "physics",
    "simulationType",
];
/// Keys the server accepts in a simulation's `provenance` (closed set).
const PROVENANCE_KEYS: &[&str] = &["model", "provider", "generationSeed", "sourceSnapshotHash"];
/// Edge-only field names, compared after lowercasing and dropping non-alphanumerics.
const FORBIDDEN_FIELDS: &[&str] = &[
    "csi",
    "rawcsi",
    "channelstateinformation",
    "cir",
    "rawcir",
    "channelimpulseresponse",
    "rftensor",
    "rftensors",
    "packetcapture",
    "packetcaptures",
    "pcap",
    "recording",
    "recordings",
    "audiorecording",
    "videorecording",
    "poseframe",
    "poseframes",
    "skeleton",
    "keypoints",
    "vitalwaveform",
    "vitalwaveforms",
    "heartratewaveform",
    "identityobservation",
    "identityobservations",
    "biometric",
    "biometrics",
    "face",
    "faces",
    "faceembedding",
];

/// Where in the Spaces hierarchy the event belongs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpacesTarget {
    /// Existing site id.
    pub site_id: String,
    /// Existing space id under that site.
    pub space_id: String,
}

/// Per-event identity and timing chosen by the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventIdentity {
    /// Event resource id.
    pub id: String,
    /// Idempotency key; a retry must reuse it.
    pub message_id: String,
    /// Monotonic sequence for this event id.
    pub event_sequence: u64,
    /// RFC 3339 timestamp of when the rollout finished.
    pub observed_at: String,
}

/// Spaces identifier rule: `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$`.
pub fn is_spaces_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 120
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

/// Builds the simulation body for one rollout.
///
/// `media_url` is where a reader can fetch the clip; when absent the worker's
/// media locator is used, which only resolves for the operator.
pub fn rollout_simulation(
    envelope: &SimulatedFrameEnvelope,
    target: &SpacesTarget,
    identity: &EventIdentity,
    media_url: Option<&str>,
) -> Result<Value, Pan2Error> {
    let provenance = &envelope.chunk.provenance;
    if !provenance.simulated {
        return Err(Pan2Error::Contract(
            "only simulated output can be published as a rollout".into(),
        ));
    }
    let clip = envelope
        .chunk
        .frames
        .iter()
        .find(|frame| frame.media_type == "video/mp4")
        .ok_or_else(|| Pan2Error::Contract("envelope has no video descriptor".into()))?;
    let event = json!({
        "id": identity.id,
        "messageId": identity.message_id,
        "eventSequence": identity.event_sequence,
        "observedAt": identity.observed_at,
        "privacy": "P2",
        "siteId": target.site_id,
        "spaceId": target.space_id,
        "simulationType": ROLLOUT_SIMULATION_TYPE,
        // A prediction is not evidence about the space; the server stores 0 regardless.
        "confidence": 0,
        "attributes": {
            "label": "Model prediction, not an observation",
            "mediaType": clip.media_type,
            "mediaSha256": clip.content_hash.trim_start_matches("sha256:"),
            "mediaBytes": clip.byte_length,
            "mediaLocator": media_url.unwrap_or(&clip.locator),
            // The server's provenance is a closed set; the rest of the run record lives here.
            "checkpoint": provenance.checkpoint,
            "runtimeVersion": provenance.runtime_version,
            "license": provenance.license.license_id,
            "sourceStreamEpoch": provenance.source_stream_epoch,
            "promptActionHash": provenance.prompt_action_hash,
            "generationSequence": provenance.generation_sequence.to_string(),
            "sessionId": envelope.session_id,
            "sessionEpoch": envelope.epoch.to_string(),
            "projectionId": provenance.privacy.projection_id,
            "hostedProcessingApproved": provenance.privacy.hosted_processing_approved,
        },
        "provenance": {
            "provider": provenance.provider,
            "model": provenance.model,
            // Strings: a u64 seed can exceed JavaScript's safe integer range.
            "generationSeed": provenance.generation_seed.to_string(),
            "sourceSnapshotHash": provenance.source_snapshot_hash,
        },
    });
    validate_simulation(&event)?;
    Ok(event)
}

fn normalized(field: &str) -> String {
    field
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn walk(node: &Value, depth: usize, nodes: &mut usize) -> Result<(), Pan2Error> {
    let contract = |message: String| Err(Pan2Error::Contract(message));
    *nodes += 1;
    if *nodes > 2_048 {
        return contract("event has too many values".into());
    }
    if depth > 8 {
        return contract("event is too deeply nested".into());
    }
    match node {
        Value::String(text) if text.len() > 2_048 => {
            contract("event contains an oversized string".into())
        }
        Value::Array(items) => {
            if items.len() > 64 {
                return contract("event contains an oversized array".into());
            }
            items
                .iter()
                .try_for_each(|item| walk(item, depth + 1, nodes))
        }
        Value::Object(map) => {
            if map.len() > 48 {
                return contract("event contains an object with too many fields".into());
            }
            for (key, child) in map {
                if FORBIDDEN_FIELDS.contains(&normalized(key).as_str()) {
                    return contract(format!("raw field `{key}` is edge-only"));
                }
                walk(child, depth + 1, nodes)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn rfc3339(value: &str) -> bool {
    // Same shape the handler's regular expression accepts.
    let bytes = value.as_bytes();
    let digits = |range: std::ops::Range<usize>| {
        bytes
            .get(range)
            .is_some_and(|part| part.iter().all(u8::is_ascii_digit))
    };
    if !(digits(0..4)
        && digits(5..7)
        && digits(8..10)
        && digits(11..13)
        && digits(14..16)
        && digits(17..19))
        || bytes.len() < 20
        || [bytes[4], bytes[7], bytes[10], bytes[13], bytes[16]] != *b"--T::"
    {
        return false;
    }
    let mut rest = &value[19..];
    if let Some(fraction) = rest.strip_prefix('.') {
        let count = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if !(1..=9).contains(&count) {
            return false;
        }
        rest = &fraction[count..];
    }
    rest == "Z"
        || (rest.len() == 6
            && matches!(rest.as_bytes()[0], b'+' | b'-')
            && rest.as_bytes()[3] == b':'
            && rest[1..3]
                .bytes()
                .chain(rest[4..6].bytes())
                .all(|b| b.is_ascii_digit()))
}

fn is_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Mirrors `validateMediaLocator`: a safe relative path or a credential-free https URL.
fn media_locator_error(locator: &str) -> Option<&'static str> {
    if locator.is_empty() || locator.len() > 512 {
        return Some("attributes.mediaLocator must be 1 to 512 bytes");
    }
    if locator.contains(['?', '#']) {
        return Some("attributes.mediaLocator must not carry a query or fragment");
    }
    if locator.len() > 8 && locator[..8].eq_ignore_ascii_case("https://") {
        let authority = locator[8..].split('/').next().unwrap_or("");
        if authority.contains('@') {
            return Some("attributes.mediaLocator must not carry credentials");
        }
        return authority
            .is_empty()
            .then_some("attributes.mediaLocator needs a host");
    }
    let safe = locator
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'/' | b'-'));
    (!safe || locator.starts_with('/') || locator.split('/').any(|part| part == ".."))
        .then_some("attributes.mediaLocator must be a safe relative path or an https URL")
}

/// Local preflight of a `POST /v1/spatial/simulations` body.
pub fn validate_simulation(simulation: &Value) -> Result<(), Pan2Error> {
    let contract = |message: &str| Err(Pan2Error::Contract(message.to_owned()));
    let body: &Map<String, Value> = match simulation.as_object() {
        Some(body) => body,
        None => return contract("simulation body must be a JSON object"),
    };
    if serde_json::to_vec(simulation)?.len() > MAX_BODY_BYTES {
        return contract("simulation body exceeds 64 KiB");
    }
    walk(simulation, 0, &mut 0)?;
    if let Some(unknown) = body
        .keys()
        .find(|key| !WRITE_FIELDS.contains(&key.as_str()))
    {
        return Err(Pan2Error::Contract(format!(
            "field `{unknown}` is not supported"
        )));
    }
    for field in ["id", "messageId", "siteId", "spaceId"] {
        if !body
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(is_spaces_id)
        {
            return Err(Pan2Error::Contract(format!(
                "{field} is missing or not a Spaces id"
            )));
        }
    }
    if !matches!(
        body.get("privacy").and_then(Value::as_str),
        Some("P2" | "P3")
    ) {
        return contract("privacy must be P2 or P3");
    }
    if !body
        .get("observedAt")
        .and_then(Value::as_str)
        .is_some_and(rfc3339)
    {
        return contract("observedAt must be an RFC 3339 timestamp");
    }
    if !body
        .get("eventSequence")
        .and_then(Value::as_u64)
        .is_some_and(|sequence| sequence <= MAX_SAFE_INTEGER)
    {
        return contract("eventSequence must be a non-negative safe integer");
    }
    let kind = body.get("simulationType").and_then(Value::as_str);
    if !kind.is_some_and(|kind| {
        let bytes = kind.as_bytes();
        (1..=80).contains(&bytes.len())
            && bytes[0].is_ascii_lowercase()
            && bytes.iter().all(|b| {
                b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
            })
    }) {
        return contract("simulationType is required (lowercase letters, digits, '.', '_', '-')");
    }
    // The server rejects any non-zero confidence on a simulation.
    if body
        .get("confidence")
        .is_some_and(|value| value.as_f64() != Some(0.0))
    {
        return contract("confidence must be 0 on a simulation");
    }
    let Some(provenance) = body.get("provenance").and_then(Value::as_object) else {
        return contract("provenance with model and provider is required on a simulation");
    };
    if let Some(extra) = provenance
        .keys()
        .find(|key| !PROVENANCE_KEYS.contains(&key.as_str()))
    {
        return Err(Pan2Error::Contract(format!(
            "provenance field `{extra}` is not supported on a simulation"
        )));
    }
    for field in ["model", "provider"] {
        if !provenance
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|text| !text.is_empty() && text.len() <= 120)
        {
            return Err(Pan2Error::Contract(format!(
                "provenance.{field} is required (at most 120 bytes)"
            )));
        }
    }
    if provenance.get("generationSeed").is_some_and(|seed| {
        !seed.as_str().is_some_and(|text| {
            (1..=20).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit())
        })
    }) {
        return contract("provenance.generationSeed must be 1 to 20 decimal digits");
    }
    if provenance.get("sourceSnapshotHash").is_some_and(|hash| {
        !hash
            .as_str()
            .and_then(|text| text.strip_prefix("sha256:"))
            .is_some_and(|hex| is_hex(hex, 64))
    }) {
        return contract("provenance.sourceSnapshotHash must be sha256: plus 64 hex characters");
    }
    if let Some(attributes) = body.get("attributes").and_then(Value::as_object) {
        if attributes
            .get("mediaSha256")
            .is_some_and(|hash| !hash.as_str().is_some_and(|hex| is_hex(hex, 64)))
        {
            return contract("attributes.mediaSha256 must be 64 lowercase hex characters");
        }
        if attributes
            .get("mediaBytes")
            .is_some_and(|bytes| !bytes.as_u64().is_some_and(|n| n <= 1 << 36))
        {
            return contract("attributes.mediaBytes must be an integer from 0 to 2^36");
        }
        if attributes.get("mediaType").is_some_and(|kind| {
            !kind
                .as_str()
                .is_some_and(|text| !text.is_empty() && text.len() <= 80 && text.contains('/'))
        }) {
            return contract("attributes.mediaType must be a media type of at most 80 bytes");
        }
        if let Some(locator) = attributes.get("mediaLocator") {
            match locator.as_str().map(media_locator_error) {
                Some(None) => {}
                Some(Some(message)) => return contract(message),
                None => return contract("attributes.mediaLocator must be a string"),
            }
        }
    } else if body.get("attributes").is_some() {
        return contract("attributes must be an object");
    }
    Ok(())
}

/// Publishes a simulation with an API key that has `spaces:simulate` (not `spaces:write`).
///
/// Returns the HTTP status and response body. Any non-2xx status is an error.
#[cfg(feature = "spaces-http")]
pub async fn publish_simulation(
    base_url: &str,
    api_key: &str,
    simulation: &Value,
) -> Result<(u16, Value), Pan2Error> {
    validate_simulation(simulation)?;
    let url = format!("{}/v1/spatial/simulations", base_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .post(url)
        .header("x-api-key", api_key)
        .json(simulation)
        .send()
        .await
        .map_err(|error| Pan2Error::Contract(format!("Spaces request failed: {error}")))?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(Pan2Error::Contract(format!(
            "Spaces returned {status}: {body}"
        )));
    }
    Ok((status.as_u16(), body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_timestamps_follow_the_handler_rules() {
        assert!(is_spaces_id("rollout:pan2-a-1.e0-s0"));
        assert!(!is_spaces_id("-leading"));
        assert!(!is_spaces_id("has space"));
        assert!(!is_spaces_id(&"a".repeat(121)));
        assert!(rfc3339("2026-11-11T10:00:00Z"));
        assert!(rfc3339("2026-11-11T10:00:00.123456789+02:00"));
        assert!(!rfc3339("2026-11-11 10:00:00Z"));
        assert!(!rfc3339("2026-11-11T10:00:00"));
        assert!(!rfc3339("2026-11-11T10:00:00.Z"));
    }

    fn valid() -> Value {
        json!({
            "id": "s1", "messageId": "m1", "eventSequence": 1, "observedAt": "2026-11-11T10:00:00Z",
            "privacy": "P2", "siteId": "site", "spaceId": "space", "simulationType": "video.rollout",
            "confidence": 0,
            "attributes": {"mediaSha256": "a".repeat(64), "mediaBytes": 10, "mediaType": "video/mp4",
                "mediaLocator": "clips/a.mp4"},
            "provenance": {"model": "PAN2", "provider": "worldgraph-pan2", "generationSeed": "123",
                "sourceSnapshotHash": format!("sha256:{}", "b".repeat(64))},
        })
    }

    #[test]
    fn a_complete_simulation_passes_and_each_server_rule_is_mirrored() {
        assert!(validate_simulation(&valid()).is_ok());
        type Case = (&'static str, fn(&mut Value));
        let cases: [Case; 14] = [
            ("recording field", |v| {
                v["attributes"]["video_recording"] = json!("x")
            }),
            ("unknown field", |v| v["mediaUrl"] = json!("x")),
            ("privacy", |v| v["privacy"] = json!("P1")),
            ("sequence", |v| {
                v["eventSequence"] = json!(MAX_SAFE_INTEGER + 1)
            }),
            ("event type instead of simulation type", |v| {
                v.as_object_mut().unwrap().remove("simulationType");
                v["eventType"] = json!("simulation.rollout");
            }),
            ("non-zero confidence", |v| v["confidence"] = json!(0.5)),
            ("missing provenance", |v| {
                v.as_object_mut().unwrap().remove("provenance");
            }),
            ("extra provenance key", |v| {
                v["provenance"]["checkpoint"] = json!("c")
            }),
            ("bad seed", |v| {
                v["provenance"]["generationSeed"] = json!("12x")
            }),
            ("bad snapshot hash", |v| {
                v["provenance"]["sourceSnapshotHash"] = json!("sha256:...")
            }),
            ("bad media hash", |v| {
                v["attributes"]["mediaSha256"] = json!("ZZ")
            }),
            ("signed url locator", |v| {
                v["attributes"]["mediaLocator"] = json!("https://x.example/a.mp4?sig=1")
            }),
            ("credentialed locator", |v| {
                v["attributes"]["mediaLocator"] = json!("https://u:p@x.example/a.mp4")
            }),
            ("traversal locator", |v| {
                v["attributes"]["mediaLocator"] = json!("../a.mp4")
            }),
        ];
        for (name, mutate) in cases {
            let mut body = valid();
            mutate(&mut body);
            assert!(
                validate_simulation(&body).is_err(),
                "{name} must be rejected"
            );
        }
        let mut recording = valid();
        recording["attributes"]["video_recording"] = json!("x");
        assert!(validate_simulation(&recording)
            .unwrap_err()
            .to_string()
            .contains("edge-only"));
        for good in ["a.mp4", "clips/a.mp4", "https://media.example.com/a/b.mp4"] {
            let mut body = valid();
            body["attributes"]["mediaLocator"] = json!(good);
            assert!(validate_simulation(&body).is_ok(), "{good}");
        }
    }
}
