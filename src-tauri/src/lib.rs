mod content;
pub mod license;
mod security;

use notify::{Event, EventKind, RecursiveMode, Watcher};
use rusqlite::params;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::sync::mpsc::channel;
use std::sync::Mutex;
use std::thread;
#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

mod db;
mod mobile;

use db::{db_path, open_db, setup_db, SearchResult};

struct AppState {
    run_in_background: Mutex<bool>,
}

static INDEX_GEN: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

// Directories that are never worth indexing
fn is_junk_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | ".git" | ".svn" | "target" | ".cache" | "__pycache__" | ".venv" | "venv"
    )
}

fn get_category(is_dir: bool, ext: &str) -> String {
    if is_dir {
        return "Folder".to_string();
    }
    match ext.to_lowercase().as_str() {
        "mp3" | "wav" | "flac" | "ogg" | "m4a" => "Music".to_string(),
        "mp4" | "mkv" | "avi" | "mov" | "webm" => "Videos".to_string(),
        "png" | "jpg" | "jpeg" | "svg" | "gif" | "webp" => "Images".to_string(),
        "pdf" | "docx" | "doc" | "txt" | "rtf" | "xlsx" | "pptx" | "epub" => {
            "Documents".to_string()
        }
        "exe" | "msi" | "bat" | "cmd" | "app" | "sh" => "Programs".to_string(),
        "zip" | "tar" | "gz" | "rar" | "7z" => "Archives".to_string(),
        "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "html" | "css" | "json" | "toml" | "yml" => {
            "Code".to_string()
        }
        _ => "Other".to_string(),
    }
}

#[tauri::command]
fn get_platform() -> String {
    #[cfg(target_os = "android")]
    {
        return "android".to_string();
    }
    #[cfg(target_os = "ios")]
    {
        return "ios".to_string();
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        "desktop".to_string()
    }
}

#[tauri::command]
fn start_indexing(
    app_handle: AppHandle,
    custom_dirs: Option<Vec<String>>,
    excluded_dirs: Option<Vec<String>>,
) -> Result<String, String> {
    // Increment generation to cancel any running indexer
    let current_gen = INDEX_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;

    let pool = app_handle.state::<db::DbPool>();
    let path = {
        let conn = match pool.get() {
            Ok(c) => c,
            Err(_) => return Err("DB lock failed".to_string()),
        };
        match conn.query_row("PRAGMA database_list", [], |row| row.get::<_, String>(2)) {
            Ok(file) => PathBuf::from(file),
            Err(_) => return Err("Failed to locate database".to_string()),
        }
    };

    let mut valid_custom_dirs = Vec::new();
    if let Some(custom) = &custom_dirs {
        let allowed = security::AllowedRoots::new(true);
        let is_pro = license::user_is_pro(&app_handle);
        let mut errors = Vec::new();
        for dir in custom {
            match allowed.validate(dir) {
                Ok(valid) => {
                    if disk_is_pro_only(&valid) && !is_pro {
                        errors.push(format!(
                            "'{}': indexing removable drives is a Pro feature",
                            dir
                        ));
                    } else {
                        valid_custom_dirs.push(valid);
                    }
                }
                Err(e) => errors.push(format!("'{}': {}", dir, e)),
            }
        }
        if !errors.is_empty() {
            return Err(format!("Invalid directories: {}", errors.join(", ")));
        }
    }

    let app_clone = app_handle.clone();

    thread::spawn(move || {
        let start_time = std::time::Instant::now();
        log::debug!("Indexing thread started");

        let done = |count: i64| {
            let _ = app_clone.emit("indexing-done", count);
            log::debug!("Indexing done in {:?}", start_time.elapsed());
        };

        let mut conn = match open_db(&path) {
            Ok(c) => c,
            Err(e) => {
                log::error!("Failed to open DB during indexing: {e}");
                return done(0);
            }
        };
        log::debug!("DB opened in {:?}", start_time.elapsed());

        // Removed existing_files memory bottleneck!
        let sync_id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let mut dirs_to_scan = Vec::new();
        #[cfg(mobile)]
        {
            dirs_to_scan.extend(mobile::scan_roots(&app_handle));
        }
        #[cfg(not(mobile))]
        {
            if let Some(doc_dir) = dirs::document_dir() {
                dirs_to_scan.push(doc_dir);
            }
            if let Some(dl_dir) = dirs::download_dir() {
                dirs_to_scan.push(dl_dir);
            }
        }
        for dir in valid_custom_dirs {
            dirs_to_scan.push(dir);
        }

        let mut exclusions = std::collections::HashSet::new();
        if let Some(excl) = excluded_dirs {
            for dir in excl {
                exclusions.insert(PathBuf::from(dir));
            }
        }

        let mut count: i64 = 0;
        const BATCH: usize = 500;

        if dirs_to_scan.is_empty() {
            return done(0);
        }

        let mut builder = ignore::WalkBuilder::new(&dirs_to_scan[0]);
        for dir in dirs_to_scan.iter().skip(1) {
            builder.add(dir);
        }
        // Don't traverse hidden directories since we are looking for user documents mostly
        builder.hidden(true);
        builder.ignore(true);
        builder.git_ignore(true);

        let (tx, rx) = channel();
        let exclusions_arc = std::sync::Arc::new(exclusions);

        log::debug!("WalkBuilder initialized in {:?}", start_time.elapsed());

        // Spawn parallel walker
        thread::spawn(move || {
            builder.build_parallel().run(|| {
                let tx = tx.clone();
                let exclusions = exclusions_arc.clone();
                Box::new(move |result| {
                    if INDEX_GEN.load(std::sync::atomic::Ordering::SeqCst) != current_gen {
                        return ignore::WalkState::Quit;
                    }
                    if let Ok(entry) = result {
                        if exclusions.contains(entry.path()) {
                            return ignore::WalkState::Skip;
                        }
                        if let Some(file_type) = entry.file_type() {
                            let is_dir = file_type.is_dir();
                            if is_dir && is_junk_dir(&entry.file_name().to_string_lossy()) {
                                return ignore::WalkState::Skip;
                            }

                            let path_str = entry.path().to_string_lossy().to_string();
                            let title_str = entry.file_name().to_string_lossy().to_string();
                            let ext = entry
                                .path()
                                .extension()
                                .and_then(|e| e.to_str())
                                .unwrap_or("");
                            let category = get_category(is_dir, ext);

                            let metadata = entry.metadata().ok();
                            let mtime = metadata
                                .as_ref()
                                .and_then(|m| m.modified().ok())
                                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                .map(|d| d.as_secs() as i64)
                                .unwrap_or(0);
                            let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);

                            let mut text_content = String::new();
                            if file_type.is_file() && content::should_index_content(ext) {
                                text_content = content::extract_text(entry.path(), ext);
                            }

                            let content_str =
                                format!("{} {} {}", title_str, path_str, text_content);
                            let _ = tx.send((
                                title_str,
                                path_str,
                                content_str,
                                mtime,
                                size as i64,
                                category,
                            ));
                        }
                    }
                    ignore::WalkState::Continue
                })
            });
        }); // tx is dropped here when parallel walker finishes

        let mut batch_insert: Vec<(String, String, String, i64, i64, String)> =
            Vec::with_capacity(BATCH);
        let mut batch_sync: Vec<String> = Vec::with_capacity(BATCH);

        let process_batches = |conn: &mut rusqlite::Connection,
                               b_insert: &mut Vec<(String, String, String, i64, i64, String)>,
                               b_sync: &mut Vec<String>| {
            if b_insert.is_empty() && b_sync.is_empty() {
                return;
            }
            if conn.execute_batch("BEGIN").is_err() {
                log::error!("Failed to BEGIN batch transaction during indexing");
                return;
            }
            let batch_result = (|| -> rusqlite::Result<()> {
                if !b_insert.is_empty() {
                    let mut stmt_idx = conn.prepare_cached(
                        "INSERT INTO file_index (title, path, content) VALUES (?1, ?2, ?3)",
                    )?;
                    let mut stmt_meta = conn.prepare_cached(
                        "INSERT OR REPLACE INTO file_metadata (path, mtime, size, sync_id, category) VALUES (?1, ?2, ?3, ?4, ?5)",
                    )?;
                    for (t, p, c, m, s, cat) in b_insert.drain(..) {
                        stmt_idx.execute(params![t, p, c])?;
                        stmt_meta.execute(params![p, m, s, sync_id, cat])?;
                    }
                }
                if !b_sync.is_empty() {
                    let mut stmt_update = conn
                        .prepare_cached("UPDATE file_metadata SET sync_id = ?1 WHERE path = ?2")?;
                    for p in b_sync.drain(..) {
                        stmt_update.execute(params![sync_id, p])?;
                    }
                }
                conn.execute_batch("COMMIT")
            })();
            if let Err(e) = batch_result {
                let _ = conn.execute_batch("ROLLBACK");
                log::error!("Batch insert failed during indexing: {e}");
            }
        };

        let mut check_mtime =
            match conn.prepare_cached("SELECT mtime FROM file_metadata WHERE path = ?1") {
                Ok(stmt) => stmt,
                Err(e) => {
                    log::error!("Failed to prepare mtime check: {e}");
                    return done(0);
                }
            };
        let mut delete_idx = match conn.prepare_cached("DELETE FROM file_index WHERE path = ?1") {
            Ok(stmt) => stmt,
            Err(e) => {
                log::error!("Failed to prepare delete statement: {e}");
                return done(0);
            }
        };

        let mut first_file = true;

        while let Ok((t, p, c, m, s, cat)) = rx.recv() {
            if INDEX_GEN.load(std::sync::atomic::Ordering::SeqCst) != current_gen {
                log::debug!("Indexing cancelled by new generation");
                return done(count);
            }

            if first_file {
                log::debug!(
                    "First file received from channel in {:?}",
                    start_time.elapsed()
                );
                first_file = false;
            }

            let mut skip_insert = false;
            if let Ok(old_mtime) = check_mtime.query_row(params![&p], |row| row.get::<_, i64>(0)) {
                if old_mtime == m {
                    skip_insert = true;
                } else {
                    let _ = delete_idx.execute(params![&p]);
                }
            }

            if skip_insert {
                batch_sync.push(p);
            } else {
                batch_insert.push((t, p, c, m, s, cat));
            }

            if batch_insert.len() >= BATCH || batch_sync.len() >= BATCH {
                drop(check_mtime); // MUST drop prepared statements before processing batch due to connection mutability
                drop(delete_idx);
                process_batches(&mut conn, &mut batch_insert, &mut batch_sync);
                (check_mtime, delete_idx) = match conn
                    .prepare_cached("SELECT mtime FROM file_metadata WHERE path = ?1")
                    .and_then(|stmt| {
                        conn.prepare_cached("DELETE FROM file_index WHERE path = ?1")
                            .map(|del| (stmt, del))
                    }) {
                    Ok(pair) => pair,
                    Err(e) => {
                        log::error!("Failed to re-prepare indexing statements: {e}");
                        return done(count);
                    }
                };
            }

            count += 1;
            if count % 100 == 0 {
                let _ = app_clone.emit("indexing-progress", count);
            }
        }
        drop(check_mtime);
        drop(delete_idx);

        // flush remainder
        process_batches(&mut conn, &mut batch_insert, &mut batch_sync);

        // Stale file cleanup
        let _ = conn.execute_batch("BEGIN");
        let _ = conn.execute(
            "DELETE FROM file_index WHERE path IN (SELECT path FROM file_metadata WHERE sync_id != ?1)",
            params![sync_id],
        );
        let _ = conn.execute(
            "DELETE FROM file_metadata WHERE sync_id != ?1",
            params![sync_id],
        );
        let _ = conn.execute_batch("COMMIT");

        done(count);
    });

    Ok("Indexing started in the background".to_string())
}

#[tauri::command]
fn search_files(
    app_handle: AppHandle,
    query: String,
    category: String,
) -> Result<Vec<SearchResult>, String> {
    let trimmed_query = query.trim();
    if trimmed_query.is_empty() {
        return Ok(vec![]);
    }

    let pool = app_handle.state::<db::DbPool>();
    let conn = pool.get().map_err(|_| "DB pool error".to_string())?;

    let is_regex = query.starts_with('/') && query.ends_with('/') && query.len() > 2;
    // Trigram can only match tokens with >= 3 alphanumeric chars; drop shorter
    // tokens from the FTS query, and fall back to LIKE when none remain.
    let alnum_len = |term: &str| term.chars().filter(|c| c.is_alphanumeric()).count();
    if alnum_len(trimmed_query) == 0 {
        return Ok(vec![]);
    }
    let trigram_capable = query.split_whitespace().any(|t| alnum_len(t) >= 3);
    let short_query = !is_regex && !trigram_capable;
    let mut final_results = Vec::new();

    let cat_filter = if category == "All" {
        ""
    } else {
        "AND m.category = ?3"
    };

    if short_query {
        let sql = format!(
            "
            SELECT f.rowid, f.title, f.path,
                   'Matched in path or title' as snippet,
                   100 as bm25,
                   m.size, m.mtime, m.category
            FROM file_index f
            LEFT JOIN file_metadata m ON f.path = m.path
            WHERE (f.path LIKE ?1 OR f.title LIKE ?2) {}
            LIMIT 50
        ",
            cat_filter
        );
        let pattern = format!("%{}%", trimmed_query);
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

        let mut params_vec: Vec<&dyn rusqlite::ToSql> = vec![&pattern, &pattern];
        if category != "All" {
            params_vec.push(&category);
        }

        let results = stmt
            .query_map(rusqlite::params_from_iter(params_vec), |row| {
                Ok(SearchResult {
                    id: row.get::<_, i64>(0)?,
                    title: row.get::<_, String>(1)?,
                    path: row.get::<_, String>(2)?,
                    snippet: row.get::<_, String>(3)?,
                    relevance: 100,
                    size: row.get::<_, i64>(5).unwrap_or(0) as u64,
                    modified: row.get::<_, i64>(6).unwrap_or(0),
                    category: row
                        .get::<_, String>(7)
                        .unwrap_or_else(|_| "Other".to_string()),
                })
            })
            .map_err(|e| e.to_string())?;

        for res in results {
            if let Ok(r) = res {
                final_results.push(r);
            } else if let Err(e) = res {
                log::debug!("LIKE query row error: {}", e);
            }
        }
    } else if is_regex {
        let regex_pattern = &query[1..query.len() - 1];
        let sql = format!(
            "
            SELECT f.rowid, f.title, f.path,
                   'Regex match found in path or title' as snippet,
                   100 as bm25,
                   m.size, m.mtime, m.category
            FROM file_index f
            LEFT JOIN file_metadata m ON f.path = m.path
            WHERE (f.path REGEXP ?1 OR f.title REGEXP ?2) {}
            LIMIT 50
        ",
            cat_filter
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

        let mut params_vec: Vec<&dyn rusqlite::ToSql> = vec![&regex_pattern, &regex_pattern];
        if category != "All" {
            params_vec.push(&category);
        }

        let results = stmt
            .query_map(rusqlite::params_from_iter(params_vec), |row| {
                Ok(SearchResult {
                    id: row.get::<_, i64>(0)?,
                    title: row.get::<_, String>(1)?,
                    path: row.get::<_, String>(2)?,
                    snippet: row.get::<_, String>(3)?,
                    relevance: 100,
                    size: row.get::<_, i64>(5).unwrap_or(0) as u64,
                    modified: row.get::<_, i64>(6).unwrap_or(0),
                    category: row
                        .get::<_, String>(7)
                        .unwrap_or_else(|_| "Other".to_string()),
                })
            })
            .map_err(|e| e.to_string())?;

        for res in results {
            if let Ok(r) = res {
                final_results.push(r);
            } else if let Err(e) = res {
                log::debug!("Regex query row error: {}", e);
            }
        }
    } else {
        let cat_filter_fts = if category == "All" {
            ""
        } else {
            "AND m.category = ?2"
        };
        let sql = format!(
            "
            SELECT file_index.rowid, file_index.title, file_index.path,
                   COALESCE(snippet(file_index, 0, '<b>', '</b>', '...', 10), snippet(file_index, 1, '<b>', '</b>', '...', 10)),
                   bm25(file_index),
                   m.size, m.mtime, m.category
            FROM file_index
            LEFT JOIN file_metadata m ON file_index.path = m.path
            WHERE file_index MATCH ?1 {}
            ORDER BY rank
            LIMIT 50
        ",
            cat_filter_fts
        );

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

        // SQLite FTS syntax for prefix search; quote terms to avoid syntax
        // errors on special characters and drop tokens trigram cannot match.
        let terms: Vec<String> = query
            .split_whitespace()
            .filter(|term| alnum_len(term) >= 3)
            .map(|term| {
                let safe_term = term.replace(['"', '*', '(', ')', '+', '-', '~'], "");
                format!("\"{}\"", safe_term)
            })
            .collect();
        let fts_query = terms.join(" AND ");

        let mut params_vec: Vec<&dyn rusqlite::ToSql> = vec![&fts_query];
        if category != "All" {
            params_vec.push(&category);
        }

        let results = stmt
            .query_map(rusqlite::params_from_iter(params_vec), |row| {
                let bm25: f64 = row.get::<_, f64>(4).unwrap_or(0.0);
                // Trigram tokenizer produces different BM25 ranges than porter.
                let relevance =
                    (100.0_f64 / (1.0_f64 + bm25.abs() * 0.15_f64)).clamp(1.0_f64, 100.0_f64) as u8;
                Ok(SearchResult {
                    id: row.get::<_, i64>(0)?,
                    title: row.get::<_, String>(1)?,
                    path: row.get::<_, String>(2)?,
                    snippet: row
                        .get::<_, String>(3)
                        .unwrap_or_else(|_| "File matched".to_string()),
                    relevance,
                    size: row.get::<_, i64>(5).unwrap_or(0) as u64,
                    modified: row.get::<_, i64>(6).unwrap_or(0),
                    category: row
                        .get::<_, String>(7)
                        .unwrap_or_else(|_| "Other".to_string()),
                })
            })
            .map_err(|e| {
                log::error!("FTS query_map error: {}", e);
                e.to_string()
            })?;

        for res in results {
            if let Ok(r) = res {
                final_results.push(r);
            } else if let Err(e) = res {
                log::debug!("FTS query row error: {}", e);
            }
        }
    }

    Ok(final_results)
}

#[tauri::command]
fn get_index_stats(app_handle: AppHandle) -> Result<usize, String> {
    let pool = app_handle.state::<db::DbPool>();
    let conn = pool.get().map_err(|_| "DB pool error".to_string())?;

    let mut stmt = conn
        .prepare("SELECT COUNT(*) FROM file_metadata WHERE category != 'Folder'")
        .map_err(|e| e.to_string())?;

    let count: i64 = stmt.query_row([], |row| row.get(0)).unwrap_or(0);

    Ok(count as usize)
}

use sysinfo::Disks;

fn disk_is_pro_only(path: &std::path::Path) -> bool {
    for disk in Disks::new_with_refreshed_list().list() {
        if disk.is_removable() && path.starts_with(disk.mount_point()) {
            return true;
        }
    }
    false
}

#[derive(serde::Serialize)]
struct DriveInfo {
    path: String,
    name: String,
    is_pro_only: bool,
}

#[tauri::command]
fn get_system_drives() -> Result<Vec<DriveInfo>, String> {
    let mut drives = Vec::new();

    let disks = Disks::new_with_refreshed_list();
    for disk in disks.list() {
        let path = disk.mount_point().to_string_lossy().to_string();
        let name = disk.name().to_string_lossy().to_string();

        // sysinfo's DiskKind is only HDD/SSD/Unknown on Windows, and the OEM
        // IOCTL it uses frequently reports Unknown(-1) for fixed NVMe/optical
        // drives. Gate on removability instead so real internal drives stay free.
        let is_pro_only = disk.is_removable();

        let display_name = if name.is_empty() {
            path.clone()
        } else {
            format!("{} ({})", path, name)
        };

        drives.push(DriveInfo {
            path: path.clone(),
            name: display_name,
            is_pro_only,
        });
    }

    if drives.is_empty() {
        for c in b'A'..=b'Z' {
            let drive = format!("{}:\\", c as char);
            if std::path::Path::new(&drive).exists() {
                drives.push(DriveInfo {
                    path: drive.clone(),
                    name: drive,
                    is_pro_only: false,
                });
            }
        }
        #[cfg(unix)]
        if std::path::Path::new("/").exists() && drives.is_empty() {
            drives.push(DriveInfo {
                path: "/".to_string(),
                name: "/".to_string(),
                is_pro_only: false,
            });
        }
    }

    Ok(drives)
}

#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
}

#[tauri::command]
fn get_directories(path: String) -> Result<Vec<DirEntry>, String> {
    let allowed = security::AllowedRoots::new(true);
    let valid_path = allowed
        .validate(&path)
        .map_err(|e| format!("Security: {}", e))?;

    let mut dirs = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&valid_path) {
        for entry in entries.filter_map(|e| e.ok()) {
            if let Ok(file_type) = entry.file_type() {
                if file_type.is_dir() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let path_str = entry.path().to_string_lossy().to_string();
                    if !is_junk_dir(&name) {
                        dirs.push(DirEntry {
                            name,
                            path: path_str,
                        });
                    }
                }
            }
        }
    }
    dirs.sort_by_key(|a| a.name.to_lowercase());
    Ok(dirs)
}

#[tauri::command]
fn delete_file(app_handle: AppHandle, path: String) -> Result<String, String> {
    let allowed = security::AllowedRoots::new(true);
    let valid_path = allowed
        .validate(&path)
        .map_err(|e| format!("Security: {}", e))?;

    match fs::remove_file(&valid_path) {
        Ok(_) => {
            // Also remove from index
            let pool = app_handle.state::<db::DbPool>();
            if let Ok(conn) = pool.get() {
                let valid_path_str = valid_path.to_string_lossy().to_string();
                let _ = conn.execute(
                    "DELETE FROM file_index WHERE path = ?1",
                    params![valid_path_str],
                );
                let _ = conn.execute(
                    "DELETE FROM file_metadata WHERE path = ?1",
                    params![valid_path_str],
                );
            }
            Ok("File deleted".to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn open_in_explorer(path: String) -> Result<String, String> {
    let allowed = security::AllowedRoots::new(true);
    let valid_path = allowed
        .validate(&path)
        .map_err(|e| format!("Security: {}", e))?;

    opener::reveal(&valid_path).map_err(|e| e.to_string())?;
    Ok("Opened".to_string())
}

#[tauri::command]
fn set_run_in_background(app_handle: AppHandle, enable: bool) -> Result<String, String> {
    if enable && !license::user_is_pro(&app_handle) {
        return Err("Running in background is a Pro feature.".to_string());
    }
    if let Ok(mut bg) = app_handle.state::<AppState>().run_in_background.lock() {
        *bg = enable;
    }
    Ok("Updated".to_string())
}

#[tauri::command]
fn exit_app(app_handle: AppHandle) {
    app_handle.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `mut` is only needed when the e2e feature re-assigns builder below
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    }

    #[cfg(feature = "e2e")]
    {
        builder = builder
            .plugin(tauri_plugin_wdio::init())
            .plugin(tauri_plugin_wdio_webdriver::init());
    }

    builder
        .setup(|app| {
            #[cfg(desktop)]
            {
                let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&quit_i])?;
                let tray_icon = app
                    .default_window_icon()
                    .cloned()
                    .ok_or("no default window icon")?;

                let _tray = TrayIconBuilder::new()
                    .icon(tray_icon)
                    .menu(&menu)
                    .on_menu_event(|app, event| if event.id.as_ref() == "quit" {
                        app.exit(0);
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            ..
                        } = event
                        {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    })
                    .build(app)?;
            }

            let app_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            setup_db(&app_dir).expect("Failed to initialize database");

            // Create connection pool (4 connections for concurrent reads)
            let manager = r2d2_sqlite::SqliteConnectionManager::file(db_path(&app_dir))
                .with_init(|c| {
                    c.pragma_update(None, "journal_mode", "WAL")?;
                    c.pragma_update(None, "synchronous", "NORMAL")?;
                    c.create_scalar_function(
                        "REGEXP",
                        2,
                        rusqlite::functions::FunctionFlags::SQLITE_UTF8
                            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
                        move |ctx| {
                            let expr = ctx.get::<String>(0)?;
                            let s = ctx.get::<String>(1)?;
                            let re = regex::RegexBuilder::new(&expr)
                                .size_limit(100_000)
                                .dfa_size_limit(1_000_000)
                                .build()
                                .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?;
                            Ok(re.is_match(&s))
                        },
                    )?;
                    Ok(())
                });
            let pool = r2d2::Pool::builder().max_size(4).build(manager).expect("Failed to create DB pool");
            app.manage(pool);

            app.manage(AppState {
                run_in_background: Mutex::new(false),
            });

            // Live Radar: Live File System Watcher
            let app_handle = app.handle().clone();
            let db_path_clone = db_path(&app_dir);

            thread::spawn(move || {
                let (tx, rx) = channel();
                let mut watcher = match notify::recommended_watcher(tx) {
                    Ok(w) => w,
                    Err(_) => return,
                };

                if let Some(dl_dir) = dirs::download_dir() {
                    let _ = watcher.watch(&dl_dir, RecursiveMode::Recursive);
                }

                let mut pending_paths = std::collections::HashSet::new();
                let mut pending_removes = std::collections::HashSet::new();
                loop {
                    let res = if pending_paths.is_empty() && pending_removes.is_empty() {
                        rx.recv().ok()
                    } else {
                        rx.recv_timeout(std::time::Duration::from_millis(500)).ok()
                    };

                    match res {
                        Some(Ok(Event { kind: EventKind::Create(_) | EventKind::Modify(_), paths, .. })) => {
                            for path in paths {
                                pending_paths.insert(path);
                            }
                            // Don't process immediately, wait for timeout to coalesce
                            continue;
                        }
                        Some(Ok(Event { kind: EventKind::Remove(_), paths, .. })) => {
                            for path in paths {
                                pending_removes.insert(path);
                            }
                            // Don't process immediately, wait for timeout to coalesce
                            continue;
                        }
                        Some(_) => continue, // Ignore other events
                        None => {
                            if pending_paths.is_empty() && pending_removes.is_empty() {
                                // Channel disconnected and nothing pending
                                break;
                            }
                        }
                    }

                    // Timeout reached or channel disconnected with pending paths
                    if !pending_paths.is_empty() || !pending_removes.is_empty() {
                        if let Ok(conn) = open_db(&db_path_clone) {
                            // Purge removed paths so they stop showing up in search
                            for path in pending_removes.drain() {
                                let path_str = path.to_string_lossy().to_string();
                                let _ = conn.execute(
                                    "DELETE FROM file_index WHERE path = ?1",
                                    params![&path_str],
                                );
                                let _ = conn.execute(
                                    "DELETE FROM file_metadata WHERE path = ?1",
                                    params![&path_str],
                                );
                            }
                            let mut processed_paths = Vec::new();
                            for path in pending_paths.drain() {
                                if !path.is_file() {
                                    continue;
                                }
                                let is_junk = path.components().any(|c| {
                                    if let std::path::Component::Normal(name) = c {
                                        is_junk_dir(&name.to_string_lossy())
                                    } else {
                                        false
                                    }
                                });
                                if is_junk {
                                    continue;
                                }
                                let path_str = path.to_string_lossy().to_string();
                                let title_str = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                                let category = get_category(false, ext);

                                let metadata = std::fs::metadata(&path).ok();
                                let mtime = metadata
                                    .as_ref()
                                    .and_then(|m| m.modified().ok())
                                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                    .map(|d| d.as_secs() as i64)
                                    .unwrap_or(0);
                                let size = metadata.map(|m| m.len()).unwrap_or(0);

                                let mut text_content = String::new();
                                if content::should_index_content(ext) {
                                    text_content = content::extract_text(&path, ext);
                                }
                                let content_str = format!("{} {} {}", title_str, path_str, text_content);

                                let _ = conn.execute("DELETE FROM file_index WHERE path = ?1", params![&path_str]);
                                let _ = conn.execute("INSERT INTO file_index (title, path, content) VALUES (?1, ?2, ?3)", params![&title_str, &path_str, &content_str]);

                                // Upsert metadata with the file's category, preserving sync_id
                                // (stale-GC uses sync_id, so keep it on updates)
                                let _ = conn.execute(
                                    "INSERT INTO file_metadata (path, mtime, size, sync_id, category) VALUES (?1, ?2, ?3, 0, ?4) ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, category = excluded.category",
                                    params![&path_str, mtime, size as i64, &category],
                                );

                                processed_paths.push(path_str);
                            }
                            if !processed_paths.is_empty() {
                                // Emit once per batch
                                let _ = app_handle.emit("live-radar-batch", processed_paths);
                            }
                        } else {
                            // DB unavailable: keep pending paths and retry on the next cycle
                            thread::sleep(std::time::Duration::from_millis(500));
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_platform,
            start_indexing,
            search_files,
            delete_file,
            get_system_drives,
            get_directories,
            open_in_explorer,
            get_index_stats,
            set_run_in_background,
            exit_app,
            mobile::get_mobile_roots,
            mobile::add_mobile_root,
            mobile::remove_mobile_root,
            mobile::import_mobile_files,
            license::get_license_status,
            license::install_license,
            license::get_device_id
        ])
        .on_window_event(|window, event| if let WindowEvent::CloseRequested { api, .. } = event {
            let state = window.app_handle().state::<AppState>();
            let run_in_bg = state.run_in_background.lock().map(|g| *g).unwrap_or(true);
            if run_in_bg {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
