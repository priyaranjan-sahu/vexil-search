//! License public-key selection, shared by the build script and the test suite.
//!
//! This lives outside `build.rs` so `cargo test` can exercise the selection
//! order and the release guard. Build scripts are compiled as build scripts,
//! never as test targets, so `#[cfg(test)]` code inside `build.rs` would never
//! be compiled or run.

use base64::Engine as _;

/// Where the embedded license public key came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeySource {
    /// `VEXIL_PUBLIC_KEY` in the build environment.
    Env,
    /// `licenses/vexil_public.prod.key`, staged by CI.
    StagedProductionFile,
    /// `licenses/vexil_public.key`, committed to the repository.
    CommittedDevFile,
}

/// A validated public key together with the source it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectedKey {
    pub base64: String,
    pub source: KeySource,
}

/// Written to the build log so the key choice is auditable after the fact.
pub fn source_note(source: KeySource) -> &'static str {
    match source {
        KeySource::Env => "embedding license public key from VEXIL_PUBLIC_KEY env",
        KeySource::StagedProductionFile => {
            "embedding license public key from CI-staged licenses/vexil_public.prod.key"
        }
        KeySource::CommittedDevFile => "embedding dev license public key (not production)",
    }
}

pub const RELEASE_GUARD_ERROR: &str =
    "Refusing to build a release with the development license public key. Stage the \
     base64 production key as src-tauri/licenses/vexil_public.prod.key (how CI does it, \
     because xcodebuild strips custom env vars from the iOS build), or set \
     VEXIL_PUBLIC_KEY. If this build is intentionally an unsigned test artifact, re-run \
     with VEXIL_ALLOW_DEV_KEY=1 so the choice is recorded in the build log.";

pub const NO_KEY_ERROR: &str = "No license public key available: set VEXIL_PUBLIC_KEY, stage \
     licenses/vexil_public.prod.key, or provide licenses/vexil_public.key";

/// Picks the key to embed, in priority order: env, CI-staged production file,
/// then the committed development file.
///
/// The staged file is treated as an explicit production-key opt-in, so it is
/// trusted in release builds without `VEXIL_ALLOW_DEV_KEY`. The committed file
/// is a development key whose private half is public, so anything signed by it
/// can be forged; shipping it in a release would let anyone mint their own Pro
/// license, so release builds must opt out of it explicitly rather than
/// inherit it by default.
pub fn select(
    env_key: Option<&str>,
    staged_file: Option<&str>,
    dev_file: Option<&str>,
    is_release: bool,
    allow_dev: bool,
) -> Result<SelectedKey, &'static str> {
    if let Some(b64) = non_empty(env_key) {
        return Ok(SelectedKey {
            base64: b64.to_string(),
            source: KeySource::Env,
        });
    }

    if let Some(b64) = non_empty(staged_file) {
        return Ok(SelectedKey {
            base64: b64.to_string(),
            source: KeySource::StagedProductionFile,
        });
    }

    if let Some(b64) = non_empty(dev_file) {
        if is_release && !allow_dev {
            return Err(RELEASE_GUARD_ERROR);
        }
        return Ok(SelectedKey {
            base64: b64.to_string(),
            source: KeySource::CommittedDevFile,
        });
    }

    Err(NO_KEY_ERROR)
}

/// An Ed25519 public key is exactly 32 bytes, so a base64 string decoding to any
/// other length would fail at runtime with a confusing error. Catching it here
/// turns a bad key into a build failure naming the real problem.
pub fn validate_32_bytes(source: KeySource, b64: &str) -> Result<(), String> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("license public key from {source:?} is not valid base64: {e}"))?;

    if decoded.len() != 32 {
        return Err(format!(
            "license public key from {source:?} must decode to 32 bytes \
             (an Ed25519 public key), got {} bytes",
            decoded.len()
        ));
    }

    Ok(())
}

/// A missing or whitespace-only key counts as absent so selection falls through
/// to the next source instead of embedding an empty key.
fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROD: &str = "xj4kxCJfCHexp7YkrkloOxihA5SGn7NQBT6aCZboRYY=";
    const DEV: &str = "D2qlHPoQWs3mWENfUQ4H6vhhxhgO7BieyMoQyDR8MZY=";

    #[test]
    fn env_key_wins_over_everything() {
        let key = select(Some(PROD), Some(PROD), Some(DEV), true, false).unwrap();
        assert_eq!(key.source, KeySource::Env);
        assert_eq!(key.base64, PROD);
    }

    /// The iOS path: xcodebuild sanitizes the environment, so CI cannot pass
    /// VEXIL_PUBLIC_KEY or VEXIL_ALLOW_DEV_KEY, and stages the key as a file.
    /// That must be honoured in a release build with no dev-key opt-in.
    #[test]
    fn staged_file_is_trusted_in_release_without_opt_in() {
        let key = select(None, Some(PROD), Some(DEV), true, false).unwrap();
        assert_eq!(key.source, KeySource::StagedProductionFile);
        assert_eq!(key.base64, PROD);
    }

    #[test]
    fn blank_env_falls_through_to_staged_file() {
        let key = select(Some("  \n"), Some(PROD), Some(DEV), true, false).unwrap();
        assert_eq!(key.source, KeySource::StagedProductionFile);
    }

    #[test]
    fn blank_staged_file_falls_through_to_dev_file() {
        let key = select(Some(""), Some("\t\n"), Some(DEV), false, false).unwrap();
        assert_eq!(key.source, KeySource::CommittedDevFile);
    }

    #[test]
    fn dev_file_in_release_is_rejected_without_opt_in() {
        assert_eq!(
            select(None, None, Some(DEV), true, false),
            Err(RELEASE_GUARD_ERROR)
        );
    }

    #[test]
    fn dev_file_in_release_is_allowed_with_opt_in() {
        let key = select(None, None, Some(DEV), true, true).unwrap();
        assert_eq!(key.source, KeySource::CommittedDevFile);
    }

    #[test]
    fn dev_file_in_debug_needs_no_opt_in() {
        let key = select(None, None, Some(DEV), false, false).unwrap();
        assert_eq!(key.source, KeySource::CommittedDevFile);
    }

    #[test]
    fn no_key_anywhere_is_an_error() {
        assert_eq!(select(None, None, None, true, false), Err(NO_KEY_ERROR));
        assert_eq!(
            select(None, Some(""), Some("   "), false, false),
            Err(NO_KEY_ERROR)
        );
    }

    #[test]
    fn each_source_is_named_in_the_build_log() {
        assert!(source_note(KeySource::Env).contains("VEXIL_PUBLIC_KEY"));
        assert!(source_note(KeySource::StagedProductionFile).contains("vexil_public.prod.key"));
        assert!(source_note(KeySource::CommittedDevFile).contains("not production"));
    }

    #[test]
    fn both_shipped_keys_are_valid_32_byte_public_keys() {
        validate_32_bytes(KeySource::StagedProductionFile, PROD).unwrap();
        validate_32_bytes(KeySource::CommittedDevFile, DEV).unwrap();
    }

    #[test]
    fn wrong_length_key_is_rejected() {
        let err = validate_32_bytes(KeySource::StagedProductionFile, "c2hvcnQ=").unwrap_err();
        assert!(err.contains("5 bytes"), "{err}");
    }

    #[test]
    fn non_base64_key_is_rejected() {
        let err = validate_32_bytes(KeySource::Env, "not base64!!").unwrap_err();
        assert!(err.contains("not valid base64"), "{err}");
    }
}
