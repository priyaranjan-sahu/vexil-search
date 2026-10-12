use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};

use crate::db;

pub const LICENSE_FILE: &str = "license.lic";
pub const WATERMARK_FILE: &str = "license_seen_at";
pub const CURRENT_PAYLOAD_VERSION: u32 = 2;
/// Tolerate the system clock moving backwards by up to a day (DST, timezone
/// changes, small drift) before refusing to honor the license.
const CLOCK_ROLLBACK_GRACE_SECS: u64 = 86_400;

/// Feature names the licensing worker grants. These strings are the contract
/// between the signer and the app: they appear in `LicensePayload::features`
/// and every gate below is keyed on them, never on the bare `pro` boolean.
pub const FEATURE_BACKGROUND: &str = "background";
pub const FEATURE_REMOVABLE_DRIVES: &str = "removable_drives";
pub const FEATURE_UNLIMITED_PICKS: &str = "unlimited_picks";

/// Every feature this build knows how to gate on. Used by `entitlements` so the
/// UI can distinguish "not granted" from "unknown to this build".
const KNOWN_FEATURES: &[&str] = &[
    FEATURE_BACKGROUND,
    FEATURE_REMOVABLE_DRIVES,
    FEATURE_UNLIMITED_PICKS,
];

// Embedded by build.rs; either the `VEXIL_PUBLIC_KEY` env (base64) or the
// committed dev key. Production builds must set VEXIL_PUBLIC_KEY to a real key.
const PUBLIC_KEY_B64: &str = include_str!(concat!(env!("OUT_DIR"), "/vexil_public.key"));

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LicensePayload {
    #[serde(default = "default_version")]
    pub version: u32,
    pub user_id: String,
    pub plan: String,
    pub features: Vec<String>,
    pub issued_at: u64,
    pub expires_at: Option<u64>,
    #[serde(default)]
    pub device_id: Option<String>,
    /// True for server-issued tokens the client re-checks against `/verify` on
    /// startup, so a token with no expiry can still be revoked after a refund.
    /// Offline keys omit this and default to false (never revocation-checked).
    #[serde(default)]
    pub renewable: bool,
}

fn default_version() -> u32 {
    CURRENT_PAYLOAD_VERSION
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    pub pro: bool,
    pub plan: String,
    pub features: Vec<String>,
    pub user_id: Option<String>,
    pub issued_at: Option<u64>,
    pub expires_at: Option<u64>,
    pub reason: String,
    /// True when this token should be re-checked against the server on startup
    /// (server-issued tokens). Offline keys and invalid licenses are false.
    pub renewable: bool,
}

/// Seconds since the Unix epoch. Exposed so other modules stamp rows with the
/// same clock the license expiry check uses.
pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// FNV-1a 64-bit — deterministic forever (no stdHasher instability) and good
/// enough: the device id is a *bound identifier*, not a secret.
fn stable_hash_hex(input: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in input.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[cfg(target_os = "windows")]
fn platform_machine_id() -> Option<String> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let key = hklm.open_subkey("SOFTWARE\\Microsoft\\Cryptography").ok()?;
    key.get_value::<String, _>("MachineGuid").ok()
}

#[cfg(target_os = "macos")]
fn platform_machine_id() -> Option<String> {
    // macOS has no /etc/machine-id. The hardware UUID is what survives a
    // reinstall and is per-machine, unlike the previous fallback
    // (`fallback:|macos|<arch>`), which was identical for every Mac of the same
    // architecture and so collapsed every user onto one "device".
    let out = std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    uuid_from_ioreg(&String::from_utf8_lossy(&out.stdout))
}

/// Pulls `IOPlatformUUID` out of `ioreg` output. Split out from the command so
/// it can be tested without macOS.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn uuid_from_ioreg(text: &str) -> Option<String> {
    for line in text.lines() {
        if let Some((_, rhs)) = line.split_once("IOPlatformUUID") {
            if let Some((_, val)) = rhs.split_once('=') {
                let uuid = val
                    .trim()
                    .trim_end_matches(';')
                    .trim()
                    .trim_matches('"')
                    .trim();
                if !uuid.is_empty() {
                    return Some(uuid.to_string());
                }
            }
        }
    }
    None
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn platform_machine_id() -> Option<String> {
    for p in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
        if let Ok(s) = std::fs::read_to_string(p) {
            let s = s.trim().to_string();
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    None
}

/// Stable device identifier used for license binding. Cached per process.
pub fn device_id() -> String {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        if let Some(id) = platform_machine_id() {
            return stable_hash_hex(&format!("vexil:{id}"));
        }
        let fallback = format!(
            "{}|{}|{}",
            std::env::var("COMPUTERNAME").unwrap_or_default(),
            std::env::consts::OS,
            std::env::consts::ARCH
        );
        stable_hash_hex(&format!("fallback:{fallback}"))
    })
    .clone()
}

pub fn signing_key_from_file(path: &Path) -> Result<SigningKey, String> {
    let b64 = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read key file: {e}"))?
        .trim()
        .to_string();
    let bytes = B64
        .decode(b64)
        .map_err(|e| format!("Key is not valid base64: {e}"))?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "Private key must be 32 bytes".to_string())?;
    Ok(SigningKey::from_bytes(&arr))
}

pub fn verifying_key_from_bytes(bytes: &[u8]) -> Result<VerifyingKey, String> {
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "Public key must be 32 bytes".to_string())?;
    VerifyingKey::from_bytes(&arr).map_err(|e| format!("Invalid public key: {e}"))
}

pub fn public_key() -> Result<VerifyingKey, String> {
    let bytes = B64
        .decode(PUBLIC_KEY_B64.trim())
        .map_err(|e| format!("Embedded public key is not valid base64: {e}"))?;
    verifying_key_from_bytes(&bytes)
}

pub fn sign_payload(signing_key: &SigningKey, payload: &LicensePayload) -> Result<String, String> {
    let body = serde_json::to_vec(payload)
        .map_err(|e| format!("Failed to serialize license payload: {e}"))?;
    let signature = signing_key.sign(&body);
    Ok(format!(
        "{}.{}",
        B64.encode(&body),
        B64.encode(signature.to_bytes())
    ))
}

/// Structural checks beyond the signature: format version and device binding.
fn payload_ok(payload: &LicensePayload) -> Result<(), String> {
    if payload.version > CURRENT_PAYLOAD_VERSION {
        return Err(format!(
            "License was issued by a newer version of Vexil (format {})",
            payload.version
        ));
    }
    if let Some(bound) = &payload.device_id {
        if bound != &device_id() {
            return Err("License is bound to another device".to_string());
        }
    }
    Ok(())
}

pub fn verify_license_text(
    raw: &str,
    key: &VerifyingKey,
    now: u64,
) -> Result<LicensePayload, String> {
    let raw = raw.trim();
    let (payload_b64, sig_b64) = raw
        .split_once('.')
        .ok_or_else(|| "Malformed license file".to_string())?;
    let body = B64
        .decode(payload_b64)
        .map_err(|e| format!("Invalid license payload encoding: {e}"))?;
    let sig = B64
        .decode(sig_b64)
        .map_err(|e| format!("Invalid signature encoding: {e}"))?;
    let signature =
        Signature::from_slice(&sig).map_err(|e| format!("Invalid signature data: {e}"))?;
    key.verify(&body, &signature)
        .map_err(|_| "License signature verification failed".to_string())?;
    let payload: LicensePayload =
        serde_json::from_slice(&body).map_err(|e| format!("Invalid license payload JSON: {e}"))?;
    payload_ok(&payload)?;
    if is_clock_before_issue(&payload, now) {
        return Err("System clock reads earlier than this license was issued".to_string());
    }
    if is_expired(&payload, now) {
        return Err("License has expired".to_string());
    }
    Ok(payload)
}

pub fn is_expired(payload: &LicensePayload, now: u64) -> bool {
    payload.expires_at.map(|exp| now > exp).unwrap_or(false)
}

/// True when `now` has moved backwards past the last-valid watermark by more
/// than the grace period (i.e. the clock was rolled back to dodge expiry).
fn is_clock_rolled_back(now: u64, watermark: u64) -> bool {
    watermark > 0 && now + CLOCK_ROLLBACK_GRACE_SECS < watermark
}

/// True when the clock reads earlier than the license's own signed `issued_at`.
///
/// This is the strong check: `issued_at` lives inside the Ed25519-signed
/// payload, so unlike the watermark it cannot be reset by deleting a file. It
/// catches any rollback large enough to move the clock behind the license's
/// issue date, which is what a user does to resurrect an expired subscription.
/// The watermark still earns its place for rollbacks too small to cross
/// `issued_at` on a long-lived license.
pub fn is_clock_before_issue(payload: &LicensePayload, now: u64) -> bool {
    now + CLOCK_ROLLBACK_GRACE_SECS < payload.issued_at
}

pub fn license_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(LICENSE_FILE)
}

fn watermark_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    dir.join(WATERMARK_FILE)
}

/// Key for the database half of the clock watermark. See [`read_watermark`].
const WATERMARK_DB_KEY: &str = "license_seen_at";

/// Highest clock reading this install has ever observed, across two
/// independent stores.
///
/// Previously this read a single `license_seen_at` file, so deleting that one
/// file reset the watermark to 0 and switched off the rollback check entirely.
/// It now takes the maximum of the file and a row in the index database, so
/// clearing one store leaves the other intact. Both stores only ever move
/// forward, so the maximum is also the least manipulable value available.
///
/// This is still local state a determined user can erase, which is why
/// [`is_clock_before_issue`] does the real work: it relies only on the signed
/// payload.
fn read_watermark(app: &AppHandle) -> u64 {
    let from_file = std::fs::read_to_string(watermark_path(app))
        .ok()
        .and_then(|s| s.trim().parse::<i64>().ok())
        .unwrap_or(0);

    let from_db = app
        .try_state::<db::DbPool>()
        .and_then(|pool| db::get_app_state(&pool, WATERMARK_DB_KEY))
        .unwrap_or(0);

    from_file.max(from_db).max(0) as u64
}

fn write_watermark(app: &AppHandle, now: u64) {
    if now <= read_watermark(app) {
        return;
    }
    let _ = std::fs::write(watermark_path(app), now.to_string());
    if let Some(pool) = app.try_state::<db::DbPool>() {
        db::set_app_state(&pool, WATERMARK_DB_KEY, now as i64);
    }
}

pub fn install(app: &AppHandle, license_text: &str) -> Result<(), String> {
    let key = public_key()?;
    let now = now_secs();
    verify_license_text(license_text, &key, now)?;
    if is_clock_rolled_back(now, read_watermark(app)) {
        return Err(
            "System clock appears to have moved backwards; license not honored".to_string(),
        );
    }
    let path = license_path(app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create app data dir: {e}"))?;
    }
    std::fs::write(&path, license_text.trim())
        .map_err(|e| format!("Failed to write license file: {e}"))?;
    write_watermark(app, now);
    Ok(())
}

pub fn status(app: &AppHandle) -> LicenseStatus {
    let path = license_path(app);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => {
            return LicenseStatus {
                pro: false,
                plan: "free".to_string(),
                features: Vec::new(),
                user_id: None,
                issued_at: None,
                expires_at: None,
                reason: "No license installed".to_string(),
                renewable: false,
            }
        }
    };
    let key = match public_key() {
        Ok(key) => key,
        Err(e) => {
            return LicenseStatus {
                pro: false,
                plan: "free".to_string(),
                features: Vec::new(),
                user_id: None,
                issued_at: None,
                expires_at: None,
                reason: e,
                renewable: false,
            }
        }
    };
    let now = now_secs();
    match verify_license_text(&raw, &key, now) {
        Ok(payload) => {
            if is_clock_rolled_back(now, read_watermark(app)) {
                return LicenseStatus {
                    pro: false,
                    plan: "free".to_string(),
                    features: Vec::new(),
                    user_id: None,
                    issued_at: None,
                    expires_at: None,
                    reason: "System clock appears to have moved backwards".to_string(),
                    renewable: false,
                };
            }
            write_watermark(app, now);
            LicenseStatus {
                pro: true,
                plan: payload.plan.clone(),
                features: payload.features.clone(),
                user_id: Some(payload.user_id.clone()),
                issued_at: Some(payload.issued_at),
                expires_at: payload.expires_at,
                reason: "Licensed".to_string(),
                renewable: payload.renewable,
            }
        }
        Err(e) => LicenseStatus {
            pro: false,
            plan: "free".to_string(),
            features: Vec::new(),
            user_id: None,
            issued_at: None,
            expires_at: None,
            reason: e,
            renewable: false,
        },
    }
}

#[tauri::command]
pub fn get_license_status(app: AppHandle) -> LicenseStatus {
    status(&app)
}

/// Resolved feature list for the installed license. The frontend gates on this
/// rather than re-deriving the rules, so the UI and the Rust gates can never
/// disagree about what a license grants.
#[tauri::command]
pub fn get_entitlements(app: AppHandle) -> Vec<String> {
    entitlements(&app)
}

#[tauri::command]
pub fn install_license(app: AppHandle, license: String) -> Result<LicenseStatus, String> {
    install(&app, &license)?;
    Ok(status(&app))
}

/// Stable device id (16 hex chars) the license server binds licenses to.
#[tauri::command]
pub fn get_device_id() -> String {
    device_id()
}

#[derive(Debug, Deserialize)]
struct ActivateLicenseReply {
    license: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ActivateLicenseErrorReply {
    error: Option<String>,
}

/// Activates a subscription by email against the deployed licensing worker.
///
/// The request is made here in Rust rather than from the webview because the
/// app CSP is `default-src 'self'`, which would silently block the cross-origin
/// POST the frontend used to make. `server` is the VITE_LICENSE_SERVER value
/// embedded at build time. Returns the issued license text on success; any
/// failure (network, HTTP error, unparseable reply) is a human-readable error
/// string the Settings form shows inline.
#[tauri::command(async)]
pub fn activate_with_email(email: String, server: String) -> Result<String, String> {
    let email = email.trim();
    if email.is_empty() {
        return Err("Enter the email you paid with.".to_string());
    }
    if !(server.starts_with("http://") || server.starts_with("https://")) {
        return Err(
            "This build has no activation server configured. ".to_string()
                + "Please use an offline activation key instead.",
        );
    }

    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(10)))
        .http_status_as_error(false)
        .build()
        .into();
    let url = format!("{}/activate", server.trim_end_matches('/'));
    let request = serde_json::json!({ "email": email, "deviceId": device_id() });

    let mut res = agent
        .post(&url)
        .header("Content-Type", "application/json")
        .header(
            "User-Agent",
            format!("vexil-search/{}", env!("CARGO_PKG_VERSION")),
        )
        .send(request.to_string())
        .map_err(|e| format!("Could not reach the activation server: {e}"))?;

    let text = res
        .body_mut()
        .read_to_string()
        .map_err(|e| format!("Could not read the activation reply: {e}"))?;

    if res.status().is_success() {
        let reply: ActivateLicenseReply = serde_json::from_str(&text).map_err(|_| {
            format!(
                "Could not parse the activation reply (HTTP {}).",
                res.status()
            )
        })?;
        let license = reply.license.unwrap_or_default();
        if license.trim().is_empty() {
            return Err("The activation server returned an empty license.".to_string());
        }
        return Ok(license);
    }

    let reply: ActivateLicenseErrorReply = serde_json::from_str(&text)
        .map_err(|_| format!("Activation failed (HTTP {}).", res.status()))?;
    Err(reply
        .error
        .unwrap_or_else(|| format!("Activation failed (HTTP {}).", res.status())))
}

#[derive(Debug, Deserialize)]
struct VerifyReply {
    #[serde(default)]
    active: bool,
}

/// Confirms a server-issued license is still active for this device.
///
/// Returns `Ok(true)` when active and `Ok(false)` when the server definitively
/// says the seat is gone (refunded, canceled, or the device was deactivated).
/// Any transport or HTTP failure is an `Err` so the caller can distinguish
/// "revoked" from "could not check" and never drop a license while offline.
#[tauri::command(async)]
pub fn verify_activation(email: String, server: String) -> Result<bool, String> {
    let email = email.trim();
    if email.is_empty() {
        return Err("No email to verify.".to_string());
    }
    if !(server.starts_with("http://") || server.starts_with("https://")) {
        return Err("No activation server configured.".to_string());
    }

    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(10)))
        .http_status_as_error(false)
        .build()
        .into();
    let url = format!("{}/verify", server.trim_end_matches('/'));
    let request = serde_json::json!({ "email": email, "deviceId": device_id() });

    let mut res = agent
        .post(&url)
        .header("Content-Type", "application/json")
        .header(
            "User-Agent",
            format!("vexil-search/{}", env!("CARGO_PKG_VERSION")),
        )
        .send(request.to_string())
        .map_err(|e| format!("Could not reach the activation server: {e}"))?;

    let text = res
        .body_mut()
        .read_to_string()
        .map_err(|e| format!("Could not read the verification reply: {e}"))?;

    if !res.status().is_success() {
        return Err(format!("Verification failed (HTTP {}).", res.status()));
    }
    let reply: VerifyReply = serde_json::from_str(&text).map_err(|_| {
        format!(
            "Could not parse the verification reply (HTTP {}).",
            res.status()
        )
    })?;
    Ok(reply.active)
}

/// Removes the installed license and returns the resulting (free) status.
///
/// Used when the server reports a license is no longer active. Removing a
/// missing file is not an error so this is safe to call defensively.
#[tauri::command]
pub fn remove_license(app: AppHandle) -> Result<LicenseStatus, String> {
    let path = license_path(&app);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(status(&app)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(status(&app)),
        Err(e) => Err(format!("Failed to remove license: {e}")),
    }
}

/// True when the installed license explicitly grants `feature`.
///
/// Authorization is per-feature, never per-plan: a license that grants only
/// `background` must not unlock removable drives. This is the single place
/// that decision is made, so every gate routes through it.
///
/// Legacy carve-out: a signature-verified pro license that lists *no* features
/// predates server-authoritative flags and is treated as granting everything.
/// This is not a bypass — the signature must still verify against the embedded
/// key, so only genuinely issued legacy licenses can reach it.
pub fn has_feature(app: &AppHandle, feature: &str) -> bool {
    let status = status(app);
    if !status.pro {
        return false;
    }
    if status.features.is_empty() {
        return true;
    }
    status.features.iter().any(|f| f == feature)
}

/// The features this build will honor for the installed license, sorted and
/// filtered to `KNOWN_FEATURES` so the UI never renders a name it cannot gate.
pub fn entitlements(app: &AppHandle) -> Vec<String> {
    let status = status(app);
    if !status.pro {
        return Vec::new();
    }
    if status.features.is_empty() {
        return KNOWN_FEATURES.iter().map(|f| f.to_string()).collect();
    }
    KNOWN_FEATURES
        .iter()
        .filter(|f| status.features.iter().any(|granted| granted == *f))
        .map(|f| f.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::OsRng;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn sample_payload() -> LicensePayload {
        LicensePayload {
            version: CURRENT_PAYLOAD_VERSION,
            user_id: "test-user".to_string(),
            plan: "pro".to_string(),
            features: vec!["background".to_string(), "removable_drives".to_string()],
            issued_at: now_secs() - 60,
            expires_at: None,
            device_id: None,
            renewable: false,
        }
    }

    #[test]
    fn uuid_from_ioreg_reads_the_hardware_uuid() {
        let sample = "\
      \"IOPlatformExpertDevice\" = {
        \"IOPlatformUUID\" = \"A1B2C3D4-1234-5678-9ABC-DEF012345678\";
        \"IOPlatformSerialNumber\" = \"C02ABCDEFGH\";
      }";
        assert_eq!(
            uuid_from_ioreg(sample).as_deref(),
            Some("A1B2C3D4-1234-5678-9ABC-DEF012345678")
        );
        assert_eq!(uuid_from_ioreg("nothing here"), None);
    }

    #[test]
    fn sign_then_verify_roundtrip() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        let payload = sample_payload();
        let token = sign_payload(&signing_key, &payload).unwrap();
        let decoded = verify_license_text(&token, &verifying_key, now_secs()).unwrap();
        assert_eq!(decoded, payload);
    }

    #[test]
    fn rejects_tampered_payload() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        let token = sign_payload(&signing_key, &sample_payload()).unwrap();
        let (payload_b64, sig_b64) = token.split_once('.').unwrap();
        let mut body = B64.decode(payload_b64).unwrap();
        body[0] ^= 0xFF;
        let forged = format!("{}.{}", B64.encode(&body), sig_b64);
        assert!(verify_license_text(&forged, &verifying_key, now_secs()).is_err());
    }

    #[test]
    fn rejects_wrong_key() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let other_key = SigningKey::generate(&mut OsRng).verifying_key();
        let token = sign_payload(&signing_key, &sample_payload()).unwrap();
        assert!(verify_license_text(&token, &other_key, now_secs()).is_err());
    }

    #[test]
    fn rejects_malformed_input() {
        assert!(verify_license_text(
            "not-a-license",
            &SigningKey::generate(&mut OsRng).verifying_key(),
            now_secs()
        )
        .is_err());
    }

    #[test]
    fn rejects_clock_reading_before_the_license_was_issued() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        let issued = now_secs();
        let payload = LicensePayload {
            issued_at: issued,
            ..sample_payload()
        };
        let token = sign_payload(&signing_key, &payload).unwrap();

        // Clock five years behind the issue date: the signature is valid and the
        // license has no expiry, so only the issued_at check can catch this.
        let rolled_back = issued - 5 * 365 * 86_400;
        let err = verify_license_text(&token, &verifying_key, rolled_back).unwrap_err();
        assert!(
            err.contains("earlier than this license was issued"),
            "{err}"
        );

        // A genuine install, where the clock runs ahead of the issue date, passes.
        assert!(verify_license_text(&token, &verifying_key, now_secs()).is_ok());
    }

    #[test]
    fn clock_before_issue_tolerates_small_drift() {
        let payload = LicensePayload {
            issued_at: 1_700_000_000,
            ..sample_payload()
        };
        // Within the grace period before the issue date: allowed.
        assert!(!is_clock_before_issue(
            &payload,
            1_700_000_000 - CLOCK_ROLLBACK_GRACE_SECS + 1
        ));
        // Comfortably before it: rejected.
        assert!(is_clock_before_issue(
            &payload,
            1_700_000_000 - CLOCK_ROLLBACK_GRACE_SECS - 1
        ));
    }

    #[test]
    fn expired_license_is_rejected() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let mut payload = sample_payload();
        payload.expires_at = Some(now_secs() - 10);
        let verifying_key = signing_key.verifying_key();
        let token = sign_payload(&signing_key, &payload).unwrap();
        let result = verify_license_text(&token, &verifying_key, now_secs());
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "License has expired");
    }

    #[test]
    fn is_expired_logic() {
        let payload = sample_payload();
        assert!(!is_expired(&payload, now_secs() + 100));
        let mut expired = payload;
        expired.expires_at = Some(1000);
        assert!(is_expired(&expired, 2000));
        assert!(!is_expired(&expired, 999));
    }

    #[test]
    fn rejects_future_payload_version() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let mut payload = sample_payload();
        payload.version = CURRENT_PAYLOAD_VERSION + 1;
        let verifying_key = signing_key.verifying_key();
        let token = sign_payload(&signing_key, &payload).unwrap();
        let err = verify_license_text(&token, &verifying_key, now_secs()).unwrap_err();
        assert!(err.contains("newer version"), "got: {err}");
    }

    #[test]
    fn legacy_payload_without_version_parses() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        let legacy = r#"{"userId":"u","plan":"pro","features":[],"issuedAt":0,"expiresAt":null}"#;
        let body = legacy.as_bytes();
        let signature = signing_key.sign(body);
        let token = format!("{}.{}", B64.encode(body), B64.encode(signature.to_bytes()));
        let payload = verify_license_text(&token, &verifying_key, now_secs()).unwrap();
        assert_eq!(payload.version, CURRENT_PAYLOAD_VERSION);
    }

    #[test]
    fn rejects_license_bound_to_another_device() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        let mut payload = sample_payload();
        payload.device_id = Some("deadbeef".to_string());
        let token = sign_payload(&signing_key, &payload).unwrap();
        let err = verify_license_text(&token, &verifying_key, now_secs()).unwrap_err();
        assert!(err.contains("another device"), "got: {err}");
    }

    #[test]
    fn accepts_license_bound_to_current_device() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        let mut payload = sample_payload();
        payload.device_id = Some(device_id());
        let token = sign_payload(&signing_key, &payload).unwrap();
        let decoded = verify_license_text(&token, &verifying_key, now_secs()).unwrap();
        assert_eq!(decoded.device_id.as_deref(), Some(device_id().as_str()));
    }

    #[test]
    fn rollback_detection_boundaries() {
        assert!(!is_clock_rolled_back(1_000, 0)); // no watermark yet
        assert!(!is_clock_rolled_back(1_000, 1_000)); // same instant
                                                      // moved back exactly the grace period -> tolerated
        assert!(!is_clock_rolled_back(
            1_000,
            1_000 + CLOCK_ROLLBACK_GRACE_SECS
        ));
        // moved back one second past grace -> caught
        assert!(is_clock_rolled_back(
            1_000,
            1_000 + CLOCK_ROLLBACK_GRACE_SECS + 1
        ));
        // clock ahead of watermark is always fine
        assert!(!is_clock_rolled_back(2_000, 1_000));
    }

    #[test]
    fn stable_hash_is_deterministic() {
        let a = stable_hash_hex("same input");
        let b = stable_hash_hex("same input");
        assert_eq!(a, b);
        assert_ne!(a, stable_hash_hex("different input"));
    }

    #[test]
    fn device_id_is_nonempty_and_stable() {
        let a = device_id();
        let b = device_id();
        assert_eq!(a, b);
        assert!(!a.is_empty());
        assert!(a.len() == 16); // 64-bit fnv-1a in hex
    }

    #[test]
    fn committed_dev_sample_verifies_with_embedded_key() {
        let raw = include_str!("../licenses/dev_sample.lic");
        let key = public_key().unwrap();
        let payload = verify_license_text(raw, &key, now_secs()).unwrap();
        assert_eq!(payload.plan, "pro");
    }

    #[test]
    fn committed_public_key_is_valid_base64_key() {
        let key = public_key().unwrap();
        assert_eq!(key.to_bytes().len(), 32);
    }

    /// Mirrors the decision `has_feature`/`entitlements` make, so the logic can
    /// be tested without an `AppHandle` (which needs a running Tauri app).
    fn grants(pro: bool, granted: &[&str], feature: &str) -> bool {
        if !pro {
            return false;
        }
        if granted.is_empty() {
            return true;
        }
        granted.contains(&feature)
    }

    fn resolved(pro: bool, granted: &[&str]) -> Vec<String> {
        if !pro {
            return Vec::new();
        }
        if granted.is_empty() {
            return KNOWN_FEATURES.iter().map(|f| f.to_string()).collect();
        }
        KNOWN_FEATURES
            .iter()
            .filter(|f| granted.contains(f))
            .map(|f| f.to_string())
            .collect()
    }

    #[test]
    fn free_user_gets_nothing() {
        assert!(!grants(false, &[], FEATURE_BACKGROUND));
        assert!(!grants(false, &[FEATURE_BACKGROUND], FEATURE_BACKGROUND));
        assert!(resolved(false, &[FEATURE_BACKGROUND]).is_empty());
    }

    #[test]
    fn features_are_scoped_not_plan_wide() {
        // A license granting only `background` must not unlock removable drives.
        let granted = [FEATURE_BACKGROUND];
        assert!(grants(true, &granted, FEATURE_BACKGROUND));
        assert!(!grants(true, &granted, FEATURE_REMOVABLE_DRIVES));
        assert!(!grants(true, &granted, FEATURE_UNLIMITED_PICKS));
        assert_eq!(resolved(true, &granted), vec![FEATURE_BACKGROUND]);
    }

    #[test]
    fn full_grant_unlocks_every_known_feature() {
        let granted = [
            FEATURE_BACKGROUND,
            FEATURE_REMOVABLE_DRIVES,
            FEATURE_UNLIMITED_PICKS,
        ];
        for f in KNOWN_FEATURES {
            assert!(grants(true, &granted, f), "expected {f}");
        }
        assert_eq!(resolved(true, &granted).len(), KNOWN_FEATURES.len());
    }

    #[test]
    fn unknown_granted_names_are_not_honored() {
        // The signer must not be able to unlock something by naming it, and a
        // stale grant for a removed feature must not leak through.
        let granted = ["time_travel", "everything"];
        assert!(!grants(true, &granted, FEATURE_BACKGROUND));
        assert!(resolved(true, &granted).is_empty());
    }

    #[test]
    fn legacy_pro_license_without_features_keeps_full_access() {
        // Pre-authorization licenses listed no features and implied full Pro.
        // Signature verification still gates this, so it is not a bypass.
        for f in KNOWN_FEATURES {
            assert!(grants(true, &[], f), "legacy license lost {f}");
        }
        assert_eq!(resolved(true, &[]).len(), KNOWN_FEATURES.len());
    }

    #[test]
    fn activate_rejects_blank_email_without_network() {
        let err = activate_with_email("   ".to_string(), "https://lic.vexil.app".to_string())
            .unwrap_err();
        assert!(err.contains("Enter the email"), "got: {err}");
    }

    #[test]
    fn activate_rejects_missing_server_without_network() {
        let err = activate_with_email("u@vexil.app".to_string(), "".to_string()).unwrap_err();
        assert!(err.contains("no activation server"), "got: {err}");
    }

    /// Serves one canned reply from a local TCP socket so the activation
    /// request can be exercised end to end without any external dependency.
    /// Returns the server base URL and a handle whose value is the request
    /// body the server received. Join the handle after the client call.
    fn spawn_server(status: u16, body: &'static str) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let payload = body.to_string();
        let served = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut byte = [0u8; 1];
            // Read headers up to the blank line without waiting for EOF.
            loop {
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
                if request.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let head = String::from_utf8_lossy(&request);
            let content_length: usize = head
                .split("\r\n")
                .find_map(|line| {
                    line.strip_prefix("Content-Length:")
                        .or_else(|| line.strip_prefix("content-length:"))
                })
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or(0);
            let mut body_buf = vec![0u8; content_length];
            stream.read_exact(&mut body_buf).unwrap();
            request.extend_from_slice(&body_buf);

            let len = payload.len();
            let resp = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n"
            );
            stream.write_all(resp.as_bytes()).unwrap();
            stream.write_all(payload.as_bytes()).unwrap();
            String::from_utf8_lossy(&request).to_string()
        });
        (format!("http://{addr}"), served)
    }

    #[test]
    fn activate_returns_the_issued_license() {
        let (base, server) = spawn_server(200, r#"{"license":"SIGNED-LICENSE"}"#);
        let license = activate_with_email("u@vexil.app".to_string(), base).unwrap();
        assert_eq!(license, "SIGNED-LICENSE");
        let echoed = server.join().unwrap();
        assert!(echoed.contains("u@vexil.app"), "got: {echoed}");
        assert!(echoed.contains("deviceId"), "got: {echoed}");
    }

    #[test]
    fn activate_surfaces_worker_error_message() {
        let (base, server) = spawn_server(403, r#"{"error":"Email not found"}"#);
        let err = activate_with_email("nobody@vexil.app".to_string(), base).unwrap_err();
        assert!(err.contains("Email not found"), "got: {err}");
        server.join().unwrap();
    }

    #[test]
    fn activate_surfaces_non_json_http_error() {
        let (base, server) = spawn_server(500, "boom");
        let err = activate_with_email("u@vexil.app".to_string(), base).unwrap_err();
        assert!(err.contains("500"), "got: {err}");
        server.join().unwrap();
    }

    #[test]
    fn verify_rejects_blank_email_without_network() {
        let err =
            verify_activation("   ".to_string(), "https://lic.vexil.app".to_string()).unwrap_err();
        assert!(err.contains("No email"), "got: {err}");
    }

    #[test]
    fn verify_rejects_missing_server_without_network() {
        let err = verify_activation("u@vexil.app".to_string(), "".to_string()).unwrap_err();
        assert!(err.contains("No activation server"), "got: {err}");
    }

    #[test]
    fn verify_reports_active_license() {
        let (base, server) = spawn_server(200, r#"{"active":true}"#);
        let active = verify_activation("u@vexil.app".to_string(), base).unwrap();
        assert!(active);
        let echoed = server.join().unwrap();
        assert!(echoed.contains("u@vexil.app"), "got: {echoed}");
        assert!(echoed.contains("deviceId"), "got: {echoed}");
    }

    #[test]
    fn verify_reports_revoked_license() {
        let (base, server) = spawn_server(200, r#"{"active":false}"#);
        let active = verify_activation("u@vexil.app".to_string(), base).unwrap();
        assert!(!active);
        server.join().unwrap();
    }

    #[test]
    fn verify_surfaces_http_error() {
        let (base, server) = spawn_server(500, "boom");
        let err = verify_activation("u@vexil.app".to_string(), base).unwrap_err();
        assert!(err.contains("500"), "got: {err}");
        server.join().unwrap();
    }

    #[test]
    fn renewable_defaults_to_false_for_legacy_tokens() {
        // A token issued before the field existed must still parse, defaulting
        // to false so it is never sent for a revocation check.
        let json = r#"{
            "version": 2,
            "userId": "u@vexil.app",
            "plan": "pro",
            "features": ["background"],
            "issuedAt": 1,
            "expiresAt": null
        }"#;
        let parsed: LicensePayload = serde_json::from_str(json).unwrap();
        assert!(!parsed.renewable);
    }

    #[test]
    fn renewable_round_trips_when_present() {
        let payload = LicensePayload {
            renewable: true,
            ..sample_payload()
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"renewable\":true"), "got: {json}");
        let parsed: LicensePayload = serde_json::from_str(&json).unwrap();
        assert!(parsed.renewable);
    }
}
