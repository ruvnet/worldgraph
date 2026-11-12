//! Field-level validation for simulated frame envelopes.

use wifi_densepose_worldmodel::{runtime::MAX_FRAME_DESCRIPTORS, SimulatedFrameEnvelope};

use super::{SimulatedError, MAX_SESSION_ID_BYTES, SIMULATED_SCHEMA_VERSION};

/// Validate everything about an envelope that does not depend on stored
/// session state.
///
/// Rejects an unsupported `schema_version`, an empty or oversized
/// `session_id`, output that is not marked `simulated`, a non-finite or
/// out-of-range confidence, more than [`MAX_FRAME_DESCRIPTORS`] frames, and
/// frame locators that embed credentials or inline media bytes.
pub fn validate_envelope(envelope: &SimulatedFrameEnvelope) -> Result<(), SimulatedError> {
    if envelope.schema_version != SIMULATED_SCHEMA_VERSION {
        return Err(invalid(format!(
            "unsupported schema_version {}; expected {SIMULATED_SCHEMA_VERSION}",
            envelope.schema_version
        )));
    }
    validate_session_id(&envelope.session_id)?;
    let provenance = &envelope.chunk.provenance;
    if !provenance.simulated {
        return Err(invalid("chunk.provenance.simulated must be true"));
    }
    if !provenance.confidence.is_finite() || !(0.0..=1.0).contains(&provenance.confidence) {
        return Err(invalid(
            "chunk.provenance.confidence must be finite and in [0,1]",
        ));
    }
    if envelope.chunk.frames.len() > MAX_FRAME_DESCRIPTORS {
        return Err(invalid(format!(
            "chunk.frames exceeds {MAX_FRAME_DESCRIPTORS} frame descriptors"
        )));
    }
    for (index, frame) in envelope.chunk.frames.iter().enumerate() {
        if locator_has_credentials(&frame.locator) {
            return Err(invalid(format!(
                "chunk.frames[{index}].locator must not contain credentials"
            )));
        }
        if locator_is_inline_media(&frame.locator) {
            return Err(invalid(format!(
                "chunk.frames[{index}].locator must reference media, not embed it"
            )));
        }
    }
    Ok(())
}

/// Validate a session identifier: 1 to [`MAX_SESSION_ID_BYTES`] UTF-8 bytes.
pub fn validate_session_id(session_id: &str) -> Result<(), SimulatedError> {
    if session_id.is_empty() || session_id.len() > MAX_SESSION_ID_BYTES {
        return Err(invalid(format!(
            "session_id must contain 1..={MAX_SESSION_ID_BYTES} bytes"
        )));
    }
    Ok(())
}

fn invalid(message: impl Into<String>) -> SimulatedError {
    SimulatedError::Invalid(message.into())
}

/// Same rule as the worldmodel runtime's private check: a `user@` part in the
/// authority of a `scheme://authority/...` locator. Scheme-relative
/// `//authority` locators are checked too, which is strictly tighter.
fn locator_has_credentials(locator: &str) -> bool {
    let rest = match locator.split_once("://") {
        Some((_, rest)) => rest,
        None => match locator.strip_prefix("//") {
            Some(rest) => rest,
            None => return false,
        },
    };
    rest.split('/')
        .next()
        .is_some_and(|authority| authority.contains('@'))
}

/// `data:` URIs carry the media itself; this channel only carries references.
fn locator_is_inline_media(locator: &str) -> bool {
    locator
        .get(..5)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("data:"))
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::envelope;
    use super::*;

    fn message(result: Result<(), SimulatedError>) -> String {
        match result {
            Err(SimulatedError::Invalid(message)) => message,
            other => panic!("expected Invalid, got {other:?}"),
        }
    }

    #[test]
    fn accepts_a_well_formed_envelope() {
        assert_eq!(validate_envelope(&envelope("s", 0, 0)), Ok(()));
    }

    #[test]
    fn rejects_each_invalid_field() {
        let mut wrong_version = envelope("s", 0, 0);
        wrong_version.schema_version = 2;
        assert!(message(validate_envelope(&wrong_version)).contains("schema_version"));

        let mut not_simulated = envelope("s", 0, 0);
        not_simulated.chunk.provenance.simulated = false;
        assert!(message(validate_envelope(&not_simulated)).contains("simulated"));

        for confidence in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, -0.01, 1.01] {
            let mut bad = envelope("s", 0, 0);
            bad.chunk.provenance.confidence = confidence;
            assert!(
                message(validate_envelope(&bad)).contains("confidence"),
                "{confidence}"
            );
        }
        for confidence in [0.0, 1.0] {
            let mut ok = envelope("s", 0, 0);
            ok.chunk.provenance.confidence = confidence;
            assert_eq!(validate_envelope(&ok), Ok(()));
        }

        assert!(message(validate_envelope(&envelope("", 0, 0))).contains("session_id"));
        let long = "x".repeat(MAX_SESSION_ID_BYTES + 1);
        assert!(message(validate_envelope(&envelope(&long, 0, 0))).contains("session_id"));
        let max = "x".repeat(MAX_SESSION_ID_BYTES);
        assert_eq!(validate_envelope(&envelope(&max, 0, 0)), Ok(()));
    }

    #[test]
    fn bounds_the_number_of_frame_descriptors() {
        let mut full = envelope("s", 0, 0);
        let frame = full.chunk.frames[0].clone();
        full.chunk.frames = vec![frame.clone(); MAX_FRAME_DESCRIPTORS];
        assert_eq!(validate_envelope(&full), Ok(()));
        full.chunk.frames.push(frame);
        assert!(message(validate_envelope(&full)).contains("frame descriptors"));
    }

    #[test]
    fn rejects_credentialed_and_inline_locators() {
        for locator in [
            "https://user@media.example/f/1",
            "https://user:secret@media.example/f/1",
            "webrtc://token@sfu",
            "//user@media.example/f/1",
        ] {
            let mut bad = envelope("s", 0, 0);
            bad.chunk.frames[0].locator = locator.into();
            assert!(
                message(validate_envelope(&bad)).contains("credentials"),
                "{locator}"
            );
        }
        for locator in ["data:video/av1;base64,AAAA", "DATA:,x"] {
            let mut bad = envelope("s", 0, 0);
            bad.chunk.frames[0].locator = locator.into();
            assert!(
                message(validate_envelope(&bad)).contains("embed"),
                "{locator}"
            );
        }
        for locator in [
            "https://media.example/f/user@1",
            "shm:segment-7",
            "opaque@id",
        ] {
            let mut ok = envelope("s", 0, 0);
            ok.chunk.frames[0].locator = locator.into();
            assert_eq!(validate_envelope(&ok), Ok(()), "{locator}");
        }
    }
}
