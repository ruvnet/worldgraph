//! Cognitum Spaces projection of a rollout.
//!
//! Spaces stores small semantic JSON, never media. A rollout is published as
//! one `POST /v1/spatial/events` body that says a simulation exists, carries
//! the clip's hash and a pointer to it, and repeats the model provenance. The
//! clip itself stays wherever the operator hosts it.
//!
//! [`validate_event`] mirrors the limits enforced by the Spaces handler
//! (`functions/api/src/api/spatial-resources.ts` in `cognitum-one/api`, read
//! 2026-11-11) so a payload is checked before it leaves the process. The
//! server remains the authority; this is a local preflight, not a guarantee.

use serde_json::{json, Map, Value};
use wifi_densepose_worldmodel::SimulatedFrameEnvelope;

use crate::Pan2Error;

/// Event type used for simulated rollouts.
pub const ROLLOUT_EVENT_TYPE: &str = "simulation.rollout";
/// Largest request body the Spaces handler accepts.
pub const MAX_EVENT_BYTES: usize = 64 * 1024;
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
];
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

/// Builds the event body for one rollout.
///
/// `media_url` is where a reader can fetch the clip; when absent the worker's
/// media locator is used, which only resolves for the operator.
pub fn rollout_event(
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
        "eventType": ROLLOUT_EVENT_TYPE,
        // A prediction is not evidence about the space.
        "confidence": 0,
        "attributes": {
            "simulated": true,
            "label": "Model prediction, not an observation",
            "mediaType": clip.media_type,
            "mediaSha256": clip.content_hash.trim_start_matches("sha256:"),
            "mediaBytes": clip.byte_length,
            "mediaLocator": media_url.unwrap_or(&clip.locator),
        },
        "provenance": {
            "simulated": true,
            "provider": provenance.provider,
            "model": provenance.model,
            "checkpoint": provenance.checkpoint,
            "runtimeVersion": provenance.runtime_version,
            "license": provenance.license.license_id,
            "sourceSnapshotHash": provenance.source_snapshot_hash,
            "sourceStreamEpoch": provenance.source_stream_epoch,
            "promptActionHash": provenance.prompt_action_hash,
            // Strings: a u64 seed can exceed JavaScript's safe integer range.
            "generationSeed": provenance.generation_seed.to_string(),
            "generationSequence": provenance.generation_sequence.to_string(),
            "sessionId": envelope.session_id,
            "sessionEpoch": envelope.epoch.to_string(),
            "projectionId": provenance.privacy.projection_id,
            "hostedProcessingApproved": provenance.privacy.hosted_processing_approved,
        },
    });
    validate_event(&event)?;
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

/// Local preflight of a `POST /v1/spatial/events` body.
pub fn validate_event(event: &Value) -> Result<(), Pan2Error> {
    let contract = |message: &str| Err(Pan2Error::Contract(message.to_owned()));
    let body: &Map<String, Value> = match event.as_object() {
        Some(body) => body,
        None => return contract("event body must be a JSON object"),
    };
    if serde_json::to_vec(event)?.len() > MAX_EVENT_BYTES {
        return contract("event body exceeds 64 KiB");
    }
    walk(event, 0, &mut 0)?;
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
    if !body
        .get("eventType")
        .and_then(Value::as_str)
        .is_some_and(|kind| !kind.is_empty() && kind.len() <= 80)
    {
        return contract("eventType is required");
    }
    if let Some(confidence) = body.get("confidence") {
        if !confidence
            .as_f64()
            .is_some_and(|value| (0.0..=1.0).contains(&value))
        {
            return contract("confidence must be in [0,1]");
        }
    }
    for field in ["attributes", "provenance"] {
        if body.get(field).is_some_and(|value| !value.is_object()) {
            return Err(Pan2Error::Contract(format!("{field} must be an object")));
        }
    }
    Ok(())
}

/// Publishes an event with an API key that has `spaces:write`.
///
/// Returns the HTTP status and response body. Any non-2xx status is an error.
#[cfg(feature = "spaces-http")]
pub async fn publish_event(
    base_url: &str,
    api_key: &str,
    event: &Value,
) -> Result<(u16, Value), Pan2Error> {
    validate_event(event)?;
    let url = format!("{}/v1/spatial/events", base_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .post(url)
        .header("x-api-key", api_key)
        .json(event)
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

    #[test]
    fn forbidden_and_unknown_fields_are_rejected_before_sending() {
        let base = json!({
            "id": "e1", "messageId": "m1", "eventSequence": 1, "observedAt": "2026-11-11T10:00:00Z",
            "privacy": "P2", "siteId": "site", "spaceId": "space", "eventType": "simulation.rollout",
            "attributes": {}, "provenance": {},
        });
        assert!(validate_event(&base).is_ok());

        let mut recording = base.clone();
        recording["attributes"]["video_recording"] = json!("x");
        let error = validate_event(&recording).unwrap_err().to_string();
        assert!(error.contains("edge-only"), "{error}");

        let mut unknown = base.clone();
        unknown["mediaUrl"] = json!("x");
        assert!(validate_event(&unknown).is_err());

        let mut privacy = base.clone();
        privacy["privacy"] = json!("P1");
        assert!(validate_event(&privacy).is_err());

        let mut sequence = base.clone();
        sequence["eventSequence"] = json!(MAX_SAFE_INTEGER + 1);
        assert!(validate_event(&sequence).is_err());

        let mut confidence = base;
        confidence["confidence"] = json!(1.5);
        assert!(validate_event(&confidence).is_err());
    }
}
