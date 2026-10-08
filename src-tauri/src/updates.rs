use serde::{Deserialize, Serialize};

/// GitHub Releases feed that drives update checks for every platform.
const LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/priyaranjan-sahu/vexil-search/releases/latest";

/// What the frontend needs to render the update banner.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub update_available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub release_url: String,
    pub notes: String,
    pub published_at: String,
}

/// The subset of GitHub's `releases/latest` payload we consume.
#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    published_at: String,
}

pub fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Tags are plain versions ("0.1.0") but tolerate a `v` prefix ("v0.1.0").
fn normalize_version(tag: &str) -> &str {
    let tag = tag.trim();
    tag.strip_prefix('v').unwrap_or(tag)
}

fn is_newer(latest: &str, current: &str) -> bool {
    match (
        semver::Version::parse(normalize_version(latest)),
        semver::Version::parse(normalize_version(current)),
    ) {
        (Ok(latest), Ok(current)) => latest > current,
        // Unparseable tags must never trigger an update prompt.
        _ => false,
    }
}

fn info_from_release_json(json: &str, current: &str) -> Result<UpdateInfo, String> {
    let release: GitHubRelease = serde_json::from_str(json)
        .map_err(|e| format!("Unexpected response from the release feed: {e}"))?;
    let latest = normalize_version(&release.tag_name).to_string();
    Ok(UpdateInfo {
        update_available: is_newer(&latest, current),
        current_version: current.to_string(),
        latest_version: latest,
        release_url: release.html_url,
        // Release notes are markdown and can be long; the banner only shows a
        // snippet, but a runaway body still must not flood the IPC channel.
        notes: release.body.chars().take(4000).collect(),
        published_at: release.published_at,
    })
}

fn fetch_latest(current: &str) -> Result<UpdateInfo, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(10)))
        .build()
        .into();
    let mut res = agent
        .get(LATEST_RELEASE_URL)
        .header("User-Agent", format!("vexil-search/{current}"))
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("Could not reach the release feed: {e}"))?;
    if !res.status().is_success() {
        // GitHub rate-limits unauthenticated API calls (60/hour); the frontend
        // treats any error as "no update known" and retries next launch.
        return Err(format!("Release feed returned HTTP {}", res.status()));
    }
    let body = res
        .body_mut()
        .read_to_string()
        .map_err(|e| format!("Could not read the release feed: {e}"))?;
    info_from_release_json(&body, current)
}

/// Ask GitHub whether a newer release than the running build exists.
/// Runs off the main thread (`async`) so the 10s network timeout can never
/// stall the webview IPC queue.
#[tauri::command(async)]
pub fn check_for_updates() -> Result<UpdateInfo, String> {
    fetch_latest(&current_version())
}

/// Downloads and installs the latest release through tauri-plugin-updater.
/// Available on desktop only; mobile builds return an error so the frontend
/// falls back to the release page in the browser.
#[cfg(desktop)]
#[tauri::command(async)]
pub async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app
        .updater()
        .map_err(|e| format!("Updater unavailable: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("Update check failed: {e}"))?
        .ok_or_else(|| "No update package is published for this platform.".to_string())?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("Download failed: {e}"))?;
    // Windows: the installer relaunches/exits the app itself once it runs.
    // macOS/Linux: the new version is on disk, bring it up now.
    #[cfg(windows)]
    {
        Ok(())
    }
    #[cfg(not(windows))]
    {
        app.restart()
    }
}

#[cfg(not(desktop))]
#[tauri::command(async)]
pub async fn install_update() -> Result<(), String> {
    Err("Auto-install is only available on desktop.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_v_prefix_from_tags() {
        assert_eq!(normalize_version("v1.2.3"), "1.2.3");
        assert_eq!(normalize_version(" 1.2.3 "), "1.2.3");
        assert_eq!(normalize_version("1.2.3"), "1.2.3");
    }

    #[test]
    fn detects_newer_versions() {
        assert!(is_newer("0.2.0", "0.1.0"));
        assert!(is_newer("0.1.1", "0.1.0"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(is_newer("v0.2.0", "0.1.0"));
    }

    #[test]
    fn equal_or_older_is_not_an_update() {
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.0.9", "0.1.0"));
    }

    #[test]
    fn prerelease_ordering_follows_semver() {
        // A prerelease of the running version is not an update...
        assert!(!is_newer("0.2.0-beta.1", "0.2.0"));
        // ...but the stable release of it is.
        assert!(is_newer("0.2.0", "0.2.0-beta.1"));
    }

    #[test]
    fn garbage_tags_never_trigger_updates() {
        assert!(!is_newer("latest", "0.1.0"));
        assert!(!is_newer("", "0.1.0"));
        assert!(!is_newer("0.1.0", "not-a-version"));
    }

    #[test]
    fn parses_release_json_into_update_info() {
        let json = r#"{
            "tag_name": "v0.2.0",
            "html_url": "https://github.com/priyaranjan-sahu/vexil-search/releases/tag/0.2.0",
            "body": "Fixes and improvements.",
            "published_at": "2026-10-01T00:00:00Z"
        }"#;
        let info = info_from_release_json(json, "0.1.0").expect("parses");
        assert!(info.update_available);
        assert_eq!(info.current_version, "0.1.0");
        assert_eq!(info.latest_version, "0.2.0");
        assert_eq!(info.published_at, "2026-10-01T00:00:00Z");
        assert_eq!(info.notes, "Fixes and improvements.");
    }

    #[test]
    fn reports_no_update_when_current_is_latest() {
        let json = r#"{
            "tag_name": "0.1.0",
            "html_url": "https://example.com/release",
            "body": "",
            "published_at": ""
        }"#;
        let info = info_from_release_json(json, "0.1.0").expect("parses");
        assert!(!info.update_available);
        assert_eq!(info.latest_version, "0.1.0");
    }

    #[test]
    fn malformed_json_is_an_error_not_a_panic() {
        assert!(info_from_release_json("not json", "0.1.0").is_err());
        assert!(info_from_release_json(r#"{"unexpected": 1}"#, "0.1.0").is_err());
    }
}
