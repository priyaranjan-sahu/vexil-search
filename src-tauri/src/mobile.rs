use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(target_os = "ios")]
use tauri::Emitter;
use tauri::{AppHandle, Manager};

use crate::license;

/// A directory (or indexable location) on a mobile device.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MobileRoot {
    pub path: String,
    pub name: String,
}

const ROOTS_FILE: &str = "mobile-roots.json";

fn roots_file(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(ROOTS_FILE)
}

/// Roots that are always available on the current platform and require no
/// extra permission (or, on Android, the already-declared all-files access).
#[cfg_attr(not(target_os = "ios"), allow(unused_variables))]
pub fn default_roots(app: &AppHandle) -> Vec<MobileRoot> {
    let mut roots = Vec::new();

    #[cfg(target_os = "android")]
    {
        let external = PathBuf::from("/storage/emulated/0");
        if external.is_dir() {
            roots.push(MobileRoot {
                path: external.to_string_lossy().into_owned(),
                name: "Phone storage".to_string(),
            });
        }
    }

    #[cfg(target_os = "ios")]
    {
        if let Ok(docs) = app.path().document_dir() {
            roots.push(MobileRoot {
                path: docs.to_string_lossy().into_owned(),
                name: "App Documents".to_string(),
            });
        }
    }

    #[cfg(desktop)]
    {
        if let Some(d) = dirs::document_dir() {
            roots.push(MobileRoot {
                path: d.to_string_lossy().into_owned(),
                name: "Documents".to_string(),
            });
        }
        if let Some(d) = dirs::download_dir() {
            roots.push(MobileRoot {
                path: d.to_string_lossy().into_owned(),
                name: "Downloads".to_string(),
            });
        }
    }

    roots
}

pub fn load_roots(app: &AppHandle) -> Vec<MobileRoot> {
    fs::read_to_string(roots_file(app))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_roots(app: &AppHandle, roots: &[MobileRoot]) -> Result<(), String> {
    let file = roots_file(app);
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(roots).map_err(|e| e.to_string())?;
    fs::write(file, json).map_err(|e| e.to_string())
}

/// Path-shape rule for Android storage volumes.
///
/// Desktop can ask the OS directly, but Android exposes no removability signal
/// that `sysinfo` reports reliably, so classify by path instead. This mirrors
/// `MainActivity.resolveTreePath`, which is the only way a path can reach
/// [`add_mobile_root`] on Android: primary shared storage resolves under
/// `/storage/emulated/<user>`, and every other volume the SAF picker offers
/// resolves to `/storage/<volumeId>` (an SD card or USB drive).
///
/// Anything unrecognised counts as removable so the gate fails closed: a new
/// mount point cannot silently become free. The internal prefixes must cover
/// the app-private directories too, or a free user would be charged Pro for
/// indexing the app's own folder.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn android_path_is_removable(path: &Path) -> bool {
    const INTERNAL_PREFIXES: [&str; 6] = [
        "/storage/emulated",
        "/storage/self/primary",
        "/data/data/",
        "/data/user/0/",
        "/sdcard",
        "/mnt/sdcard",
    ];
    let p = path.to_string_lossy();
    !INTERNAL_PREFIXES.iter().any(|prefix| p.starts_with(prefix))
}

/// Whether `path` lives on removable media, and so needs the Pro entitlement.
fn path_is_removable(path: &Path) -> bool {
    #[cfg(target_os = "android")]
    {
        android_path_is_removable(path)
    }
    #[cfg(not(target_os = "android"))]
    {
        crate::disk_is_pro_only(path)
    }
}

/// Paths that will be scanned by [`start_indexing`]: platform defaults plus
/// the roots the user picked (persisted across restarts).
#[cfg_attr(not(mobile), allow(dead_code))]
pub fn scan_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = default_roots(app)
        .into_iter()
        .filter(|r| Path::new(&r.path).is_dir())
        .map(|r| PathBuf::from(r.path))
        .collect();

    // Checked here as well as in `add_mobile_root` because these roots persist
    // across restarts: one added while Pro would otherwise keep being indexed
    // after the licence lapses. Without this, the desktop gate in
    // `start_indexing` never applies on mobile, because `custom_dirs` is only
    // ever populated by the desktop directory tree.
    let can_index_removable = license::has_feature(app, license::FEATURE_REMOVABLE_DRIVES);

    for configured in load_roots(app) {
        let path = PathBuf::from(configured.path);
        if !path.is_dir() || roots.contains(&path) {
            continue;
        }
        if path_is_removable(&path) && !can_index_removable {
            log::warn!(
                "Skipping removable root without a Pro licence: {}",
                path.display()
            );
            continue;
        }
        roots.push(path);
    }

    roots
}

#[tauri::command]
pub fn get_mobile_roots(app: AppHandle) -> Result<Vec<MobileRoot>, String> {
    let mut roots = default_roots(&app);
    for configured in load_roots(&app) {
        if !roots.contains(&configured) {
            roots.push(configured);
        }
    }
    Ok(roots)
}

#[tauri::command]
pub fn add_mobile_root(
    app: AppHandle,
    path: String,
    name: Option<String>,
) -> Result<Vec<MobileRoot>, String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("Folder does not exist or is not readable: {path}"));
    }
    if !target.is_dir() {
        return Err(format!("Not a folder: {path}"));
    }

    if path_is_removable(&target) && !license::has_feature(&app, license::FEATURE_REMOVABLE_DRIVES)
    {
        return Err(format!(
            "'{}': indexing SD cards and USB storage is a Pro feature",
            path
        ));
    }

    let display = name.unwrap_or_else(|| {
        target
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone())
    });

    let entry = MobileRoot {
        path,
        name: display,
    };
    let mut roots = load_roots(&app);
    if !roots.contains(&entry) {
        roots.push(entry);
        save_roots(&app, &roots)?;
    }
    Ok(roots)
}

#[tauri::command]
pub fn remove_mobile_root(app: AppHandle, path: String) -> Result<Vec<MobileRoot>, String> {
    let mut roots = load_roots(&app);
    let before = roots.len();
    roots.retain(|r| r.path != path);
    if roots.len() != before {
        save_roots(&app, &roots)?;
    }
    Ok(roots)
}

/// iOS: open the system document picker and copy the selected files into the
/// app sandbox (`FileAccessMode::Copy`), registering their parent directory (or
/// the directory itself) as an indexable root so imports stay searchable.
///
/// The picker returns `file://` URLs; both `FilePath` variants are handled
/// because the plugin may surface the file as a URL or a direct path.
#[tauri::command]
pub fn import_mobile_files(app: AppHandle) -> Result<String, String> {
    #[cfg(target_os = "ios")]
    {
        use tauri_plugin_dialog::{DialogExt, FileAccessMode, FilePath};

        let handle = app.clone();
        app.dialog()
            .file()
            .set_file_access_mode(FileAccessMode::Copy)
            .pick_files(move |files| {
                let Some(files) = files else {
                    return;
                };
                let mut imported = 0usize;
                for file in files {
                    let path = match file {
                        FilePath::Path(p) => Some(p),
                        FilePath::Url(url) => url.to_file_path().ok(),
                    };
                    if let Some(p) = path {
                        if add_root_for_path(&handle, &p).is_ok() {
                            imported += 1;
                        }
                    }
                }
                log::info!("Imported {imported} file(s) on iOS");
                let _ = handle.emit("mobile-files-imported", imported);
            });
        Ok("File import started".to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        Err("Importing files is only available on iOS".to_string())
    }
}

#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
fn add_root_for_path(app: &AppHandle, path: &Path) -> Result<(), String> {
    let target = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| path.to_path_buf())
    };
    if !target.is_dir() {
        return Ok(());
    }
    add_mobile_root(app.clone(), target.to_string_lossy().into_owned(), None)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::android_path_is_removable;
    use std::path::Path;

    /// The free default root. Blocking this would charge every free user for
    /// indexing their own phone, which is the whole point of the feature.
    #[test]
    fn primary_shared_storage_is_free() {
        for p in [
            "/storage/emulated/0",
            "/storage/emulated/0/Downloads",
            "/storage/emulated/0/Documents/My Reports",
        ] {
            assert!(
                !android_path_is_removable(Path::new(p)),
                "{p} should not be treated as removable"
            );
        }
    }

    /// App-private storage is internal even though it is not under /storage.
    #[test]
    fn app_private_storage_is_free() {
        for p in [
            "/data/data/com.vexil.app/files",
            "/data/user/0/com.vexil.app",
        ] {
            assert!(
                !android_path_is_removable(Path::new(p)),
                "{p} should not be treated as removable"
            );
        }
    }

    /// Legacy aliases of primary storage must not read as a second volume,
    /// or an existing user's free setup would suddenly look like Pro content.
    #[test]
    fn legacy_primary_aliases_are_free() {
        for p in ["/sdcard", "/sdcard/DCIM", "/mnt/sdcard/Download"] {
            assert!(
                !android_path_is_removable(Path::new(p)),
                "{p} should not be treated as removable"
            );
        }
    }

    /// Secondary volumes, exactly as MainActivity.resolveTreePath emits them.
    #[test]
    fn secondary_volumes_are_pro() {
        for p in [
            "/storage/1AEF-2D18",
            "/storage/1AEF-2D18/Music",
            "/storage/7D64-13A9/DCIM/Camera",
        ] {
            assert!(
                android_path_is_removable(Path::new(p)),
                "{p} should be treated as removable"
            );
        }
    }

    /// Fails closed: an unrecognised mount point is charged as Pro rather than
    /// handed out for free.
    #[test]
    fn unknown_paths_are_treated_as_removable() {
        for p in ["/mnt/media_rw/ABCD-1234", "/some/new/mount/point"] {
            assert!(
                android_path_is_removable(Path::new(p)),
                "{p} should fail closed to removable"
            );
        }
    }
}
