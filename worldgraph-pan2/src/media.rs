//! Media-channel helpers: hashing, name checks, and descriptor verification.
//!
//! Generated video never crosses the JSON control socket (ADR-204 §2). The
//! worker writes files under its media root and returns a [`FrameDescriptor`]
//! per file. The operator copies that directory over a separate channel, and
//! the client accepts a file only after [`verify_frame`] has matched its size
//! and SHA-256 against the descriptor.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use wifi_densepose_worldmodel::FrameDescriptor;

use crate::Pan2Error;

/// Transport name used in descriptors produced by the PAN 2 worker.
pub const MEDIA_TRANSPORT: &str = "pan2-media";
/// Largest generated file the client will accept (512 MiB, the ADR-204 chunk quota).
pub const MAX_MEDIA_BYTES: u64 = 512 * 1024 * 1024;

/// Lowercase hex SHA-256 of a byte slice.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Streams a file and returns `(lowercase hex SHA-256, byte length)`.
pub fn sha256_file(path: &Path) -> Result<(String, u64), Pan2Error> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1 << 16];
    let mut total = 0_u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
    Ok((hex(&hasher.finalize()), total))
}

/// Accepts exactly 64 lowercase hexadecimal characters.
pub fn check_sha256(value: &str) -> Result<(), Pan2Error> {
    if value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        Ok(())
    } else {
        Err(Pan2Error::invalid(
            "a SHA-256 must be 64 lowercase hexadecimal characters",
        ))
    }
}

/// Accepts a flat ASCII file name with one of the allowed extensions.
///
/// The rule matches RuLab's capture frames: at most 128 characters, starts
/// with a letter or digit, and uses letters, digits, `_`, `-` and single dots.
pub fn check_flat_name(name: &str, extensions: &[&str]) -> Result<(), Pan2Error> {
    let bad = |why: &str| Pan2Error::invalid(format!("file name `{name}` {why}"));
    if name.is_empty() || name.len() > 128 {
        return Err(bad("must contain 1 to 128 characters"));
    }
    if !name.as_bytes()[0].is_ascii_alphanumeric() {
        return Err(bad("must start with a letter or digit"));
    }
    if !name
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
    {
        return Err(bad("may only use letters, digits, `_`, `-` and `.`"));
    }
    if name.contains("..") || name.ends_with('.') {
        return Err(bad("has an empty dot component"));
    }
    let extension = name.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
    if !extensions.contains(&extension) {
        return Err(bad("has an unsupported extension"));
    }
    Ok(())
}

/// Accepts a session-scoped path component (letters, digits, `_`, `-`).
pub fn check_component(component: &str) -> Result<(), Pan2Error> {
    if component.is_empty()
        || component.len() > 128
        || !component
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        return Err(Pan2Error::invalid(format!(
            "path component `{component}` must be 1 to 128 letters, digits, `_` or `-`"
        )));
    }
    Ok(())
}

/// Media locator for one file of one generation step.
pub fn locator(session_id: &str, epoch: u64, sequence: u64, file: &str) -> String {
    format!("{session_id}/e{epoch}-s{sequence}/{file}")
}

/// Resolves a worker locator under a local media root, refusing traversal.
pub fn resolve_locator(root: &Path, locator: &str) -> Result<PathBuf, Pan2Error> {
    let parts: Vec<&str> = locator.split('/').collect();
    let [session, step, file] = parts.as_slice() else {
        return Err(Pan2Error::invalid(format!(
            "locator `{locator}` must be `<session>/<step>/<file>`"
        )));
    };
    check_component(session)?;
    check_component(step)?;
    check_flat_name(file, &["mp4", "json", "png", "jpg", "jpeg"])?;
    Ok(root.join(session).join(step).join(file))
}

/// Confirms that the local copy of a described file has the advertised size
/// and SHA-256, and returns its path.
pub fn verify_frame(root: &Path, frame: &FrameDescriptor) -> Result<PathBuf, Pan2Error> {
    let mismatch = |reason: String| Pan2Error::MediaMismatch {
        file: frame.locator.clone(),
        reason,
    };
    if frame.transport != MEDIA_TRANSPORT {
        return Err(mismatch(format!(
            "unexpected transport `{}`",
            frame.transport
        )));
    }
    if frame.byte_length == 0 || frame.byte_length > MAX_MEDIA_BYTES {
        return Err(mismatch(
            "advertised size is outside 1 byte to 512 MiB".into(),
        ));
    }
    let expected = frame
        .content_hash
        .strip_prefix("sha256:")
        .ok_or_else(|| mismatch("content hash is not `sha256:<hex>`".into()))?;
    check_sha256(expected)?;
    let path = resolve_locator(root, &frame.locator)?;
    let on_disk = std::fs::metadata(&path)
        .map_err(|error| mismatch(format!("cannot stat local copy: {error}")))?
        .len();
    if on_disk != frame.byte_length {
        return Err(mismatch(format!(
            "size is {on_disk} bytes, descriptor says {}",
            frame.byte_length
        )));
    }
    let (actual, _) = sha256_file(&path)?;
    if actual != expected {
        return Err(mismatch(format!(
            "SHA-256 is {actual}, descriptor says {expected}"
        )));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "worldgraph-pan2-media-{label}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn descriptor(bytes: &[u8]) -> FrameDescriptor {
        FrameDescriptor {
            transport: MEDIA_TRANSPORT.into(),
            locator: locator("pan2-1", 0, 0, "clip.mp4"),
            content_hash: format!("sha256:{}", sha256_hex(bytes)),
            byte_length: bytes.len() as u64,
            media_type: "video/mp4".into(),
        }
    }

    #[test]
    fn known_digest() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn names_reject_traversal_and_odd_extensions() {
        assert!(check_flat_name("clip.mp4", &["mp4"]).is_ok());
        assert!(check_flat_name("frame-000.first.png", &["png"]).is_ok());
        for bad in [
            "../clip.mp4",
            ".hidden.mp4",
            "a/b.mp4",
            "clip..mp4",
            "clip.exe",
            "",
            "clip.mp4.",
        ] {
            assert!(check_flat_name(bad, &["mp4"]).is_err(), "{bad}");
        }
        assert!(resolve_locator(Path::new("/m"), "../x/clip.mp4").is_err());
        assert!(resolve_locator(Path::new("/m"), "s/e0-s0/../clip.mp4").is_err());
        assert!(resolve_locator(Path::new("/m"), "s/clip.mp4").is_err());
        assert_eq!(
            resolve_locator(Path::new("/m"), "s/e0-s0/clip.mp4").unwrap(),
            PathBuf::from("/m/s/e0-s0/clip.mp4")
        );
    }

    #[test]
    fn verify_accepts_matching_bytes_and_rejects_tampering() {
        let root = temp_dir("verify");
        let bytes = b"not really a video".to_vec();
        let frame = descriptor(&bytes);
        let path = resolve_locator(&root, &frame.locator).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(verify_frame(&root, &frame).unwrap(), path);

        // Same length, different content: only the hash catches it.
        std::fs::write(&path, b"not really a vidEo").unwrap();
        let error = verify_frame(&root, &frame).unwrap_err().to_string();
        assert!(error.contains("SHA-256"), "{error}");

        std::fs::write(&path, b"short").unwrap();
        let error = verify_frame(&root, &frame).unwrap_err().to_string();
        assert!(error.contains("size"), "{error}");

        let mut wrong_transport = frame.clone();
        wrong_transport.transport = "https".into();
        assert!(verify_frame(&root, &wrong_transport).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
