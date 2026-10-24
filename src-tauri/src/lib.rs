mod content;
mod ios_open;
pub mod license;
mod security;

// Build scripts are never test targets, so the key-selection logic is shared
// with `build.rs` and compiled here only under test.
#[cfg(test)]
#[path = "../build_key.rs"]
mod build_key;

#[cfg(desktop)]
use notify::{Event, EventKind, RecursiveMode, Watcher};
use rusqlite::params;
use serde::Serialize;
use std::path::PathBuf;
#[cfg(desktop)]
use std::sync::mpsc::channel;
use std::sync::mpsc::sync_channel;
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
// Android-only: bridges to the Storage Access Framework through JNI.
#[cfg(target_os = "android")]
mod saf;
mod trash;
mod updates;

use db::{db_path, open_db, setup_db, SearchResult};

struct AppState {
    run_in_background: Mutex<bool>,
}

static INDEX_GEN: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// One indexed item as it flows from a scanner to the database writer:
/// (title, path, content, mtime, size, category).
#[cfg(target_os = "android")]
pub(crate) type IndexRow = (String, String, String, i64, i64, String);

// Directories that are never worth indexing
fn is_junk_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | ".git" | ".svn" | "target" | ".cache" | "__pycache__" | ".venv" | "venv"
    )
}

/// True when the file is a cloud-storage placeholder (OneDrive / Dropbox
/// "online-only"). Reading it would hydrate multi-gigabyte files over the
/// network on the user's behalf, so content extraction must skip it. The file
/// stays in the index by name/path; only its body text is deferred.
#[cfg(target_os = "windows")]
fn is_cloud_placeholder(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    is_cloud_placeholder_bits(metadata.file_attributes())
}

#[cfg(not(target_os = "windows"))]
fn is_cloud_placeholder(_metadata: &std::fs::Metadata) -> bool {
    false
}

/// FILE_ATTRIBUTE_OFFLINE (0x1000), RECALL_ON_OPEN (0x40000) and
/// RECALL_ON_DATA_ACCESS (0x400000) each mean "body is not on this disk";
/// unrelated upper bits may be set together with them.
#[cfg(target_os = "windows")]
fn is_cloud_placeholder_bits(attrs: u32) -> bool {
    const OFFLINE: u32 = 0x0000_1000;
    const RECALL_ON_OPEN: u32 = 0x0004_0000;
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    attrs & (OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS) != 0
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
async fn start_indexing(
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
        let can_index_removable =
            license::has_feature(&app_handle, license::FEATURE_REMOVABLE_DRIVES);
        let mut errors = Vec::new();
        for dir in custom {
            match allowed.validate(dir) {
                Ok(valid) => {
                    if disk_is_pro_only(&valid) && !can_index_removable {
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
            dirs_to_scan.extend(mobile::raw_scan_roots(&app_handle));
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

        // On Android without All Files Access, picked folders are only reachable
        // through SAF, so there can be SAF roots even when no raw directory is
        // indexable.
        #[cfg(target_os = "android")]
        let saf_roots = mobile::saf_scan_roots(&app_handle);
        #[cfg(not(target_os = "android"))]
        let saf_roots: Vec<mobile::MobileRoot> = Vec::new();

        if dirs_to_scan.is_empty() && saf_roots.is_empty() {
            return done(0);
        }

        // Bounded so the parallel walker can never outrun the single SQLite
        // writer and buffer the whole filesystem's metadata (plus extracted
        // text) in memory. When the queue is full the walker threads block
        // instead, which is the backpressure we want.
        let (tx, rx) = sync_channel(1024);
        #[cfg(target_os = "android")]
        let saf_tx = tx.clone();

        let exclusions_arc = std::sync::Arc::new(exclusions);

        if dirs_to_scan.is_empty() {
            // No raw directories: the SAF thread below keeps `tx` alive.
            drop(tx);
            drop(exclusions_arc);
        } else {
            let mut builder = ignore::WalkBuilder::new(&dirs_to_scan[0]);
            for dir in dirs_to_scan.iter().skip(1) {
                builder.add(dir);
            }
            // Don't traverse hidden directories since we are looking for user documents mostly
            builder.hidden(true);
            builder.ignore(true);
            builder.git_ignore(true);

            log::debug!("WalkBuilder initialized in {:?}", start_time.elapsed());

            // Walker threads read mtime straight from the index so they can
            // skip text extraction for files the writer is about to skip
            // anyway. WAL allows concurrent readers, so this never blocks the
            // single writer below.
            let walker_db = path.clone();

            // Spawn parallel walker
            thread::spawn(move || {
                builder.build_parallel().run(|| {
                    let tx = tx.clone();
                    let exclusions = exclusions_arc.clone();
                    let mtime_conn: Option<rusqlite::Connection> =
                        match rusqlite::Connection::open_with_flags(
                            &walker_db,
                            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                        ) {
                            Ok(c) => {
                                if let Err(e) = c.busy_timeout(std::time::Duration::from_secs(5)) {
                                    log::warn!("Walker get mtime check unavailable: {e}");
                                    None
                                } else {
                                    Some(c)
                                }
                            }
                            Err(e) => {
                                log::warn!("Walker read connection unavailable: {e}");
                                None
                            }
                        };
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

                                // A full rescan used to run text extraction for every
                                // indexable file before the writer had a chance to see
                                // the file was unchanged, so every launch re-parsed
                                // every PDF and DOCX on disk. Ask the index first:
                                // unchanged files skip extraction entirely and only
                                // pay for their sync_id stamp.
                                let already_indexed = match mtime_conn.as_ref() {
                                    Some(c) if mtime != 0 => {
                                        let stmt =
                                            "SELECT mtime FROM file_metadata WHERE path = ?1";
                                        match c.query_row(stmt, params![&path_str], |row| {
                                            row.get::<_, i64>(0)
                                        }) {
                                            Ok(old) => old == mtime,
                                            Err(_) => false,
                                        }
                                    }
                                    _ => false,
                                };

                                let mut text_content = String::new();
                                if !already_indexed
                                    && file_type.is_file()
                                    && content::should_index_content(ext)
                                    // Never read a cloud placeholder's body: that
                                    // hydrates the real file over the network.
                                    && !metadata
                                        .as_ref()
                                        .map(is_cloud_placeholder)
                                        .unwrap_or(false)
                                {
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
        }

        // Walk picked SAF folders through the same channel so they share the
        // single SQLite writer below.
        #[cfg(target_os = "android")]
        if !saf_roots.is_empty() {
            let saf_app = app_clone.clone();
            thread::spawn(move || {
                mobile::scan_saf_roots(&saf_app, &saf_roots, |row| {
                    if INDEX_GEN.load(std::sync::atomic::Ordering::SeqCst) != current_gen {
                        return false;
                    }
                    saf_tx.send(row).is_ok()
                });
            });
        }

        let mut batch_insert: Vec<(String, String, String, i64, i64, String)> =
            Vec::with_capacity(BATCH);
        let mut batch_sync: Vec<String> = Vec::with_capacity(BATCH);

        let process_batches = |conn: &rusqlite::Connection,
                               b_insert: &mut Vec<(String, String, String, i64, i64, String)>,
                               b_sync: &mut Vec<String>|
         -> i64 {
            if b_insert.is_empty() && b_sync.is_empty() {
                return 0;
            }
            // Take ownership of the batch so a failure can never silently drop
            // rows: if the transaction aborts, the rows are retried individually
            // below instead of being consumed by a dropped `drain` iterator.
            let inserts = std::mem::take(b_insert);
            let syncs = std::mem::take(b_sync);

            let batch_result = (|| -> rusqlite::Result<()> {
                conn.execute_batch("BEGIN")?;
                if !inserts.is_empty() {
                    let mut stmt_idx = conn.prepare_cached(
                        "INSERT INTO file_index (title, path, content) VALUES (?1, ?2, ?3)",
                    )?;
                    let mut stmt_meta = conn.prepare_cached(
                        "INSERT OR REPLACE INTO file_metadata (path, mtime, size, sync_id, category) VALUES (?1, ?2, ?3, ?4, ?5)",
                    )?;
                    for (t, p, c, m, s, cat) in &inserts {
                        stmt_idx.execute(params![t, p, c])?;
                        stmt_meta.execute(params![p, m, s, sync_id, cat])?;
                    }
                }
                if !syncs.is_empty() {
                    let mut stmt_update = conn
                        .prepare_cached("UPDATE file_metadata SET sync_id = ?1 WHERE path = ?2")?;
                    for p in &syncs {
                        stmt_update.execute(params![sync_id, p])?;
                    }
                }
                conn.execute_batch("COMMIT")
            })();

            if batch_result.is_ok() {
                return inserts.len() as i64;
            }

            // One bad row used to abort the whole transaction *and* drop the
            // rest of the batch, then still report it as indexed. Roll back and
            // retry each row on its own so a single unindexable file cannot take
            // its neighbours with it, and so the returned count is truthful.
            let _ = conn.execute_batch("ROLLBACK");
            log::error!(
                "Batch transaction failed; retrying {} rows individually",
                inserts.len()
            );
            let mut committed: i64 = 0;
            for (t, p, c, m, s, cat) in &inserts {
                let single = (|| -> rusqlite::Result<()> {
                    conn.execute_batch("BEGIN")?;
                    {
                        let mut stmt_idx = conn.prepare_cached(
                            "INSERT INTO file_index (title, path, content) VALUES (?1, ?2, ?3)",
                        )?;
                        stmt_idx.execute(params![t, p, c])?;
                    }
                    {
                        let mut stmt_meta = conn.prepare_cached(
                            "INSERT OR REPLACE INTO file_metadata (path, mtime, size, sync_id, category) VALUES (?1, ?2, ?3, ?4, ?5)",
                        )?;
                        stmt_meta.execute(params![p, m, s, sync_id, cat])?;
                    }
                    conn.execute_batch("COMMIT")
                })();
                match single {
                    Ok(()) => committed += 1,
                    Err(e) => {
                        let _ = conn.execute_batch("ROLLBACK");
                        log::error!("Skipping file that could not be indexed ({p}): {e}");
                    }
                }
            }
            for p in &syncs {
                let _ = conn.execute(
                    "UPDATE file_metadata SET sync_id = ?1 WHERE path = ?2",
                    params![sync_id, p],
                );
            }
            committed
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
        // Rows actually committed, as opposed to `count` (files seen). The two
        // differ only when a row fails to index, and `indexing-done` must report
        // the former so the number the user sees is trustworthy.
        let mut indexed: i64 = 0;

        while let Ok((t, p, c, m, s, cat)) = rx.recv() {
            if INDEX_GEN.load(std::sync::atomic::Ordering::SeqCst) != current_gen {
                log::debug!("Indexing cancelled by new generation");
                return done(indexed);
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
                indexed += process_batches(&mut conn, &mut batch_insert, &mut batch_sync);
                (check_mtime, delete_idx) = match conn
                    .prepare_cached("SELECT mtime FROM file_metadata WHERE path = ?1")
                    .and_then(|stmt| {
                        conn.prepare_cached("DELETE FROM file_index WHERE path = ?1")
                            .map(|del| (stmt, del))
                    }) {
                    Ok(pair) => pair,
                    Err(e) => {
                        log::error!("Failed to re-prepare indexing statements: {e}");
                        return done(indexed);
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
        indexed += process_batches(&mut conn, &mut batch_insert, &mut batch_sync);

        // Stale file cleanup. The walker stamps every file it sees with this
        // scan's `sync_id`; anything still carrying an *older* stamp was not
        // seen in this scan and no longer exists. The predicate is `<` and not
        // `!=` on purpose: the Live Radar watcher stamps live changes with the
        // current wall-clock time, which can be *newer* than this scan's stamp
        // for a file created while the scan is running. Those rows must survive
        // this GC, not be swept up as "different from the scan id".
        let _ = conn.execute_batch("BEGIN");
        let _ = conn.execute(
            "DELETE FROM file_index WHERE path IN (SELECT path FROM file_metadata WHERE sync_id < ?1)",
            params![sync_id],
        );
        let _ = conn.execute(
            "DELETE FROM file_metadata WHERE sync_id < ?1",
            params![sync_id],
        );
        let _ = conn.execute_batch("COMMIT");

        done(indexed);
    });

    Ok("Indexing started in the background".to_string())
}

#[derive(Default, Debug, Clone)]
pub struct StructuredQuery {
    pub text_query: String,
    pub ext: Option<String>,
    pub folder: Option<String>,
    pub min_size: Option<i64>,
    pub max_size: Option<i64>,
}

impl StructuredQuery {
    pub fn has_filters(&self) -> bool {
        self.ext.is_some()
            || self.folder.is_some()
            || self.min_size.is_some()
            || self.max_size.is_some()
    }

    pub fn to_sql_clauses(&self) -> String {
        let mut sql = String::new();
        if let Some(ref ext) = self.ext {
            let safe_ext = ext
                .chars()
                .filter(|c| c.is_alphanumeric())
                .collect::<String>();
            if !safe_ext.is_empty() {
                sql.push_str(&format!(
                    " AND (f.title LIKE '%.{safe_ext}' OR f.path LIKE '%.{safe_ext}')"
                ));
            }
        }
        if let Some(ref folder) = self.folder {
            let escaped = folder
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
                .replace('\'', "''");
            sql.push_str(&format!(" AND f.path LIKE '%{escaped}%' ESCAPE '\\'"));
        }
        if let Some(min) = self.min_size {
            sql.push_str(&format!(" AND m.size >= {min}"));
        }
        if let Some(max) = self.max_size {
            sql.push_str(&format!(" AND m.size <= {max}"));
        }
        sql
    }

    pub fn to_fts_sql_clauses(&self) -> String {
        let mut sql = String::new();
        if let Some(ref ext) = self.ext {
            let safe_ext = ext
                .chars()
                .filter(|c| c.is_alphanumeric())
                .collect::<String>();
            if !safe_ext.is_empty() {
                sql.push_str(&format!(
                    " AND (file_index.title LIKE '%.{safe_ext}' OR file_index.path LIKE '%.{safe_ext}')"
                ));
            }
        }
        if let Some(ref folder) = self.folder {
            let escaped = folder
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
                .replace('\'', "''");
            sql.push_str(&format!(
                " AND file_index.path LIKE '%{escaped}%' ESCAPE '\\'"
            ));
        }
        if let Some(min) = self.min_size {
            sql.push_str(&format!(" AND m.size >= {min}"));
        }
        if let Some(max) = self.max_size {
            sql.push_str(&format!(" AND m.size <= {max}"));
        }
        sql
    }
}

pub fn parse_size_str(s: &str) -> Option<i64> {
    let s = s.trim().to_lowercase();
    if let Some(num) = s.strip_suffix("gb") {
        num.parse::<f64>()
            .ok()
            .map(|v| (v * 1024.0 * 1024.0 * 1024.0) as i64)
    } else if let Some(num) = s.strip_suffix("mb") {
        num.parse::<f64>()
            .ok()
            .map(|v| (v * 1024.0 * 1024.0) as i64)
    } else if let Some(num) = s.strip_suffix("kb") {
        num.parse::<f64>().ok().map(|v| (v * 1024.0) as i64)
    } else if let Some(num) = s.strip_suffix('b') {
        num.parse::<i64>().ok()
    } else {
        s.parse::<i64>().ok()
    }
}

pub fn parse_structured_query(raw: &str) -> StructuredQuery {
    let mut text_parts = Vec::new();
    let mut ext = None;
    let mut folder = None;
    let mut min_size = None;
    let mut max_size = None;

    for token in raw.split_whitespace() {
        if let Some(val) = token.strip_prefix("ext:") {
            let clean = val.trim_start_matches('.').to_lowercase();
            if !clean.is_empty() {
                ext = Some(clean);
            }
        } else if let Some(val) = token.strip_prefix("folder:") {
            if !val.is_empty() {
                folder = Some(val.to_string());
            }
        } else if let Some(val) = token.strip_prefix("path:") {
            if !val.is_empty() {
                folder = Some(val.to_string());
            }
        } else if let Some(val) = token.strip_prefix("size:>") {
            min_size = parse_size_str(val);
        } else if let Some(val) = token.strip_prefix("size:<") {
            max_size = parse_size_str(val);
        } else {
            text_parts.push(token);
        }
    }

    StructuredQuery {
        text_query: text_parts.join(" "),
        ext,
        folder,
        min_size,
        max_size,
    }
}

fn parse_fts_query(query: &str, category_is_all: bool) -> (String, Vec<String>, String) {
    let alnum_len = |term: &str| term.chars().filter(|c| c.is_alphanumeric()).count();
    let mut fts_terms: Vec<String> = Vec::new();
    let mut short_terms: Vec<String> = Vec::new();

    for term in query.split_whitespace() {
        if alnum_len(term) >= 3 {
            let safe_term = term.replace(['"', '*', '(', ')', '+', '-', '~'], "");
            if !safe_term.is_empty() {
                fts_terms.push(format!("\"{}\"", safe_term));
            }
        } else {
            let escaped = term
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            if !escaped.is_empty() {
                short_terms.push(format!("%{}%", escaped));
            }
        }
    }

    let fts_query = fts_terms.join(" AND ");
    let mut short_filter_sql = String::new();
    for i in 0..short_terms.len() {
        let p_title = if category_is_all {
            2 + i * 2
        } else {
            3 + i * 2
        };
        let p_path = p_title + 1;
        short_filter_sql.push_str(&format!(
            " AND (file_index.title LIKE ?{p_title} ESCAPE '\\' OR file_index.path LIKE ?{p_path} ESCAPE '\\')"
        ));
    }

    (fts_query, short_terms, short_filter_sql)
}

#[tauri::command]
async fn search_files(
    app_handle: AppHandle,
    query: String,
    category: String,
    limit: Option<i64>,
    offset: Option<i64>,
    sort_by: Option<String>,
    sort_order: Option<String>,
) -> Result<Vec<SearchResult>, String> {
    let trimmed_query = query.trim();
    if trimmed_query.is_empty() {
        return Ok(vec![]);
    }

    let structured = parse_structured_query(trimmed_query);
    let search_term = structured.text_query.trim().to_string();
    if search_term.is_empty() && !structured.has_filters() {
        return Ok(vec![]);
    }

    let limit = limit.unwrap_or(50).clamp(1, 200);
    let offset = offset.unwrap_or(0).max(0);

    let pool = app_handle.state::<db::DbPool>();
    let conn = pool.get().map_err(|_| "DB pool error".to_string())?;

    let mut final_results = Vec::new();

    let cat_filter = if category == "All" {
        ""
    } else {
        "AND m.category = ?3"
    };

    let sort_desc = !matches!(sort_order.as_deref(), Some("asc") | Some("ASC"));

    let order_sql = match sort_by.as_deref() {
        Some("modified") | Some("date") => {
            if sort_desc {
                "ORDER BY m.mtime DESC, f.rowid"
            } else {
                "ORDER BY m.mtime ASC, f.rowid"
            }
        }
        Some("size") => {
            if sort_desc {
                "ORDER BY m.size DESC, f.rowid"
            } else {
                "ORDER BY m.size ASC, f.rowid"
            }
        }
        Some("name") | Some("title") => {
            if sort_desc {
                "ORDER BY f.title COLLATE NOCASE DESC, f.rowid"
            } else {
                "ORDER BY f.title COLLATE NOCASE ASC, f.rowid"
            }
        }
        _ => "ORDER BY f.rowid",
    };

    let order_fts_sql = match sort_by.as_deref() {
        Some("modified") | Some("date") => {
            if sort_desc {
                "ORDER BY m.mtime DESC, file_index.rowid"
            } else {
                "ORDER BY m.mtime ASC, file_index.rowid"
            }
        }
        Some("size") => {
            if sort_desc {
                "ORDER BY m.size DESC, file_index.rowid"
            } else {
                "ORDER BY m.size ASC, file_index.rowid"
            }
        }
        Some("name") | Some("title") => {
            if sort_desc {
                "ORDER BY file_index.title COLLATE NOCASE DESC, file_index.rowid"
            } else {
                "ORDER BY file_index.title COLLATE NOCASE ASC, file_index.rowid"
            }
        }
        _ => "ORDER BY bm25(file_index, 10.0, 5.0, 1.0), file_index.rowid",
    };

    if search_term.is_empty() {
        let sql = format!(
            "
            SELECT f.rowid, f.title, f.path,
                   'Matched search filter' as snippet,
                   100 as bm25,
                   m.size, m.mtime, m.category
            FROM file_index f
            LEFT JOIN file_metadata m ON f.path = m.path
            WHERE 1=1 {} {}
            {}
            LIMIT {limit} OFFSET {offset}
        ",
            cat_filter,
            structured.to_sql_clauses(),
            order_sql
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut params_vec: Vec<&dyn rusqlite::ToSql> = vec![];
        if category != "All" {
            params_vec.push(&category);
        }
        let results = stmt
            .query_map(rusqlite::params_from_iter(params_vec), |row| {
                Ok(SearchResult {
                    id: row.get::<_, i64>(0)?,
                    title: row.get::<_, String>(1)?,
                    path: row.get::<_, String>(2)?,
                    snippet: row
                        .get::<_, String>(3)
                        .unwrap_or_else(|_| "Matched filter".to_string()),
                    relevance: 100,
                    size: row.get::<_, i64>(5).unwrap_or(0) as u64,
                    modified: row.get::<_, i64>(6).unwrap_or(0),
                    category: row
                        .get::<_, String>(7)
                        .unwrap_or_else(|_| "Other".to_string()),
                })
            })
            .map_err(|e| e.to_string())?;

        for r in results.flatten() {
            final_results.push(r);
        }
        return Ok(final_results);
    }

    let is_regex =
        search_term.starts_with('/') && search_term.ends_with('/') && search_term.len() > 2;
    let alnum_len = |term: &str| term.chars().filter(|c| c.is_alphanumeric()).count();
    let trigram_capable = search_term.split_whitespace().any(|t| alnum_len(t) >= 3);
    let short_query = !is_regex && !trigram_capable;

    if short_query {
        let sql = format!(
            "
            SELECT f.rowid, f.title, f.path,
                   'Matched in path or title' as snippet,
                   100 as bm25,
                   m.size, m.mtime, m.category
            FROM file_index f
            LEFT JOIN file_metadata m ON f.path = m.path
            WHERE (f.path LIKE ?1 ESCAPE '\\' OR f.title LIKE ?2 ESCAPE '\\') {} {}
            {}
            LIMIT {limit} OFFSET {offset}
        ",
            cat_filter,
            structured.to_sql_clauses(),
            order_sql
        );
        let escaped = search_term
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let pattern = format!("%{}%", escaped);
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
        let regex_pattern = &search_term[1..search_term.len() - 1];
        let sql = format!(
            "
            SELECT f.rowid, f.title, f.path,
                   'Regex match found in path or title' as snippet,
                   100 as bm25,
                   m.size, m.mtime, m.category
            FROM file_index f
            LEFT JOIN file_metadata m ON f.path = m.path
            WHERE (f.path REGEXP ?1 OR f.title REGEXP ?2) {} {}
            {}
            LIMIT {limit} OFFSET {offset}
        ",
            cat_filter,
            structured.to_sql_clauses(),
            order_sql
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
        let (fts_query, short_terms, short_filter_sql) =
            parse_fts_query(&search_term, category == "All");
        let sql = format!(
            "
            SELECT file_index.rowid, file_index.title, file_index.path,
                   COALESCE(
                        snippet(file_index, -1, '<b>', '</b>', '...', 12),
                        'The file matched your search'
                   ),
                   bm25(file_index, 10.0, 5.0, 1.0),
                   m.size, m.mtime, m.category
            FROM file_index
            LEFT JOIN file_metadata m ON file_index.path = m.path
            WHERE file_index MATCH ?1 {} {} {}
            {}
            LIMIT {limit} OFFSET {offset}
        ",
            cat_filter_fts,
            short_filter_sql,
            structured.to_fts_sql_clauses(),
            order_fts_sql
        );

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

        let mut params_vec: Vec<&dyn rusqlite::ToSql> = vec![&fts_query];
        if category != "All" {
            params_vec.push(&category);
        }
        for st in &short_terms {
            params_vec.push(st);
            params_vec.push(st);
        }

        let results = stmt
            .query_map(rusqlite::params_from_iter(params_vec), |row| {
                let bm25: f64 = row.get::<_, f64>(4).unwrap_or(0.0);
                let score = (-bm25).max(0.0);
                let relevance = ((score / (score + 2.0)) * 100.0).clamp(1.0, 100.0) as u8;
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
async fn search_count(
    app_handle: AppHandle,
    query: String,
    category: String,
) -> Result<i64, String> {
    let trimmed_query = query.trim();
    if trimmed_query.is_empty() {
        return Ok(0);
    }

    let structured = parse_structured_query(trimmed_query);
    let search_term = structured.text_query.trim().to_string();
    if search_term.is_empty() && !structured.has_filters() {
        return Ok(0);
    }

    let pool = app_handle.state::<db::DbPool>();
    let conn = pool.get().map_err(|_| "DB pool error".to_string())?;

    let cat_filter = if category == "All" {
        ""
    } else {
        "AND m.category = ?3"
    };

    if search_term.is_empty() {
        let sql = format!(
            "SELECT COUNT(*) FROM file_index f \
             LEFT JOIN file_metadata m ON f.path = m.path \
             WHERE 1=1 {} {}",
            cat_filter,
            structured.to_sql_clauses()
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut params_vec: Vec<&dyn rusqlite::ToSql> = vec![];
        if category != "All" {
            params_vec.push(&category);
        }
        return stmt
            .query_row(rusqlite::params_from_iter(params_vec), |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|e| e.to_string());
    }

    let is_regex =
        search_term.starts_with('/') && search_term.ends_with('/') && search_term.len() > 2;
    let alnum_len = |term: &str| term.chars().filter(|c| c.is_alphanumeric()).count();
    let trigram_capable = search_term.split_whitespace().any(|t| alnum_len(t) >= 3);
    let short_query = !is_regex && !trigram_capable;

    let count = if short_query {
        let sql = format!(
            "SELECT COUNT(*) FROM file_index f \
             LEFT JOIN file_metadata m ON f.path = m.path \
             WHERE (f.path LIKE ?1 ESCAPE '\\' OR f.title LIKE ?2 ESCAPE '\\') {} {}",
            cat_filter,
            structured.to_sql_clauses()
        );
        let escaped = search_term
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let pattern = format!("%{}%", escaped);
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut params_vec: Vec<&dyn rusqlite::ToSql> = vec![&pattern, &pattern];
        if category != "All" {
            params_vec.push(&category);
        }
        stmt.query_row(rusqlite::params_from_iter(params_vec), |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|e| e.to_string())?
    } else if is_regex {
        let regex_pattern = &search_term[1..search_term.len() - 1];
        let sql = format!(
            "SELECT COUNT(*) FROM file_index f \
             LEFT JOIN file_metadata m ON f.path = m.path \
             WHERE (f.path REGEXP ?1 OR f.title REGEXP ?2) {} {}",
            cat_filter,
            structured.to_sql_clauses()
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut params_vec: Vec<&dyn rusqlite::ToSql> = vec![&regex_pattern, &regex_pattern];
        if category != "All" {
            params_vec.push(&category);
        }
        stmt.query_row(rusqlite::params_from_iter(params_vec), |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|e| e.to_string())?
    } else {
        let cat_filter_fts = if category == "All" {
            ""
        } else {
            "AND m.category = ?2"
        };
        let (fts_query, short_terms, short_filter_sql) =
            parse_fts_query(&search_term, category == "All");
        let sql = format!(
            "SELECT COUNT(*) FROM file_index \
             LEFT JOIN file_metadata m ON file_index.path = m.path \
             WHERE file_index MATCH ?1 {} {} {}",
            cat_filter_fts,
            short_filter_sql,
            structured.to_fts_sql_clauses()
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut params_vec: Vec<&dyn rusqlite::ToSql> = vec![&fts_query];
        if category != "All" {
            params_vec.push(&category);
        }
        for st in &short_terms {
            params_vec.push(st);
            params_vec.push(st);
        }
        stmt.query_row(rusqlite::params_from_iter(params_vec), |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|e| e.to_string())?
    };

    Ok(count)
}

#[tauri::command]
async fn cancel_indexing(app_handle: AppHandle) -> Result<String, String> {
    INDEX_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let _ = app_handle.emit("indexing-cancelled", ());
    Ok("Indexing cancelled".to_string())
}

#[derive(serde::Serialize, Debug)]
pub struct FilePreview {
    pub path: String,
    pub title: String,
    pub size: u64,
    pub modified: i64,
    pub is_text: bool,
    pub content: String,
    pub lines_count: usize,
    pub extension: String,
}

#[tauri::command]
async fn get_file_preview(app_handle: AppHandle, path: String) -> Result<FilePreview, String> {
    let allowed = security::AllowedRoots::new(true);
    let valid_path = allowed
        .validate(&path)
        .map_err(|e| format!("Security: {}", e))?;

    let canonical = valid_path.to_string_lossy().to_string();
    let pool = app_handle.state::<db::DbPool>();
    let conn = pool.get().map_err(|_| "DB pool error".to_string())?;
    if !path_is_indexed(&conn, &canonical, &path).map_err(|e| format!("Security: {}", e))? {
        return Err("Security: refusing preview for non-indexed file".to_string());
    }

    let meta = std::fs::metadata(&valid_path).map_err(|e| e.to_string())?;
    let size = meta.len();
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let title = valid_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let ext = valid_path
        .extension()
        .map(|e| e.to_string_lossy().to_string().to_lowercase())
        .unwrap_or_default();

    let (is_text, preview_content, lines) = if size < 10 * 1024 * 1024 {
        match std::fs::File::open(&valid_path) {
            Ok(file) => {
                use std::io::Read;
                let mut take = file.take(16 * 1024);
                let mut buf = Vec::new();
                if take.read_to_end(&mut buf).is_ok() {
                    if let Ok(text) = std::str::from_utf8(&buf) {
                        let lines = text.lines().count();
                        (true, text.chars().take(2000).collect::<String>(), lines)
                    } else {
                        (false, String::new(), 0)
                    }
                } else {
                    (false, String::new(), 0)
                }
            }
            Err(_) => (false, String::new(), 0),
        }
    } else {
        (false, String::new(), 0)
    };

    Ok(FilePreview {
        path,
        title,
        size,
        modified,
        is_text,
        content: preview_content,
        lines_count: lines,
        extension: ext,
    })
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct DuplicateFile {
    pub id: i64,
    pub path: String,
    pub title: String,
    pub size: u64,
    pub modified: i64,
    pub category: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct DuplicateGroup {
    pub hash: String,
    pub size: u64,
    pub wasted_bytes: u64,
    pub files: Vec<DuplicateFile>,
}

fn hash_file_bytes(path: &std::path::Path) -> Result<u64, std::io::Error> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::Hasher;
    use std::io::Read;

    let mut file = std::fs::File::open(path)?;
    let mut hasher = DefaultHasher::new();
    let mut buffer = [0u8; 64 * 1024];

    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.write(&buffer[..n]);
    }
    Ok(hasher.finish())
}

#[tauri::command]
async fn find_duplicates(app_handle: AppHandle) -> Result<Vec<DuplicateGroup>, String> {
    let pool = app_handle.state::<db::DbPool>();
    let conn = pool.get().map_err(|_| "DB pool error".to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT m.id, m.path, i.title, m.size, m.modified, m.category
             FROM file_metadata m
             JOIN file_index i ON m.id = i.id
             WHERE m.size > 0
               AND m.category != 'Folder'
               AND m.size IN (
                 SELECT size FROM file_metadata WHERE size > 0 AND category != 'Folder' GROUP BY size HAVING count(*) > 1
               )
             ORDER BY m.size DESC",
        )
        .map_err(|e| e.to_string())?;

    let candidates = stmt
        .query_map([], |row| {
            Ok(DuplicateFile {
                id: row.get(0)?,
                path: row.get(1)?,
                title: row.get(2)?,
                size: row.get::<_, i64>(3)? as u64,
                modified: row.get(4)?,
                category: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<DuplicateFile>, rusqlite::Error>>()
        .map_err(|e| e.to_string())?;

    let mut by_size: std::collections::HashMap<u64, Vec<DuplicateFile>> =
        std::collections::HashMap::new();
    for file in candidates {
        by_size.entry(file.size).or_default().push(file);
    }

    let mut duplicate_groups: Vec<DuplicateGroup> = Vec::new();

    for (size, files) in by_size {
        if files.len() < 2 {
            continue;
        }

        let mut by_hash: std::collections::HashMap<u64, Vec<DuplicateFile>> =
            std::collections::HashMap::new();
        for file in files {
            let p = std::path::Path::new(&file.path);
            if let Ok(hash) = hash_file_bytes(p) {
                by_hash.entry(hash).or_default().push(file);
            }
        }

        for (hash_val, matching_files) in by_hash {
            if matching_files.len() >= 2 {
                let wasted = size * (matching_files.len() as u64 - 1);
                duplicate_groups.push(DuplicateGroup {
                    hash: format!("{:016x}", hash_val),
                    size,
                    wasted_bytes: wasted,
                    files: matching_files,
                });
            }
        }
    }

    duplicate_groups.sort_by_key(|a| std::cmp::Reverse(a.wasted_bytes));

    Ok(duplicate_groups)
}

#[tauri::command]
async fn get_index_stats(app_handle: AppHandle) -> Result<usize, String> {
    let pool = app_handle.state::<db::DbPool>();
    let conn = pool.get().map_err(|_| "DB pool error".to_string())?;

    let mut stmt = conn
        .prepare("SELECT COUNT(*) FROM file_metadata WHERE category != 'Folder'")
        .map_err(|e| e.to_string())?;

    let count: i64 = stmt.query_row([], |row| row.get(0)).unwrap_or(0);

    Ok(count as usize)
}

const BROWSE_LIMIT: i64 = 50;
const BROWSE_SECTION_LIMIT: i64 = 10;

/// How many My Picks the free tier may keep. Enforced here rather than in the
/// frontend so the cap cannot be bypassed by editing local storage.
const FREE_PICK_LIMIT: usize = 5;

#[tauri::command]
async fn list_my_picks(app_handle: AppHandle) -> Result<Vec<SearchResult>, String> {
    let pool = app_handle.state::<db::DbPool>();
    let conn = pool.get().map_err(|_| "DB pool error".to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.title, '', p.path, 0, p.size, p.modified, p.category
             FROM my_picks p
             ORDER BY p.added_at DESC, p.id DESC",
        )
        .map_err(|e| e.to_string())?;

    let picks = stmt
        .query_map([], |row| {
            Ok(SearchResult {
                id: row.get(0)?,
                title: row.get(1)?,
                snippet: String::new(),
                path: row.get(3)?,
                relevance: row.get(4)?,
                size: row.get::<_, i64>(5)? as u64,
                modified: row.get(6)?,
                category: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<SearchResult>, rusqlite::Error>>()
        .map_err(|e| e.to_string())?;

    Ok(picks)
}

/// Adds a pick, enforcing the free-tier cap.
///
/// Re-adding an existing path is always allowed and is a no-op, so this cannot
/// be used to lock a user out of their own saved items.
#[tauri::command]
async fn add_my_pick(app_handle: AppHandle, pick: SearchResult) -> Result<(), String> {
    let unlimited = license::has_feature(&app_handle, license::FEATURE_UNLIMITED_PICKS);
    let pool = app_handle.state::<db::DbPool>();
    let conn = pool.get().map_err(|_| "DB pool error".to_string())?;

    let already_saved: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM my_picks WHERE path = ?1",
            rusqlite::params![pick.path],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    if already_saved > 0 {
        return Ok(());
    }

    if !unlimited {
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM my_picks", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if count as usize >= FREE_PICK_LIMIT {
            return Err(format!(
                "Free tier is limited to {FREE_PICK_LIMIT} My Picks. Please upgrade to Pro."
            ));
        }
    }

    conn.execute(
        "INSERT OR IGNORE INTO my_picks (path, title, size, modified, category, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            pick.path,
            pick.title,
            pick.size as i64,
            pick.modified,
            pick.category,
            license::now_secs() as i64
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn remove_my_pick(app_handle: AppHandle, id: i64) -> Result<(), String> {
    let pool = app_handle.state::<db::DbPool>();
    let conn = pool.get().map_err(|_| "DB pool error".to_string())?;
    conn.execute("DELETE FROM my_picks WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Serialize, Clone)]
struct BrowseSection {
    category: String,
    count: usize,
    files: Vec<SearchResult>,
}

// Newest files for one category, reused by both the "All" overview (short
// preview per section) and the single-category drill-down (full list).
fn browse_category_files(
    conn: &rusqlite::Connection,
    category: &str,
    limit: i64,
) -> Result<Vec<SearchResult>, String> {
    let mut stmt = conn
        .prepare(
            "
            SELECT f.rowid, f.title, f.path, '' as snippet, 0 as bm25,
                   m.size, m.mtime, m.category
            FROM file_index f
            LEFT JOIN file_metadata m ON f.path = m.path
            WHERE m.category = ?1
            ORDER BY m.mtime DESC, f.rowid DESC
            LIMIT ?2
        ",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![category, limit], |row| {
            Ok(SearchResult {
                id: row.get::<_, i64>(0)?,
                title: row.get::<_, String>(1)?,
                path: row.get::<_, String>(2)?,
                snippet: String::new(),
                relevance: 0,
                size: row.get::<_, i64>(5).unwrap_or(0) as u64,
                modified: row.get::<_, i64>(6).unwrap_or(0),
                category: row
                    .get::<_, String>(7)
                    .unwrap_or_else(|_| "Other".to_string()),
            })
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for row in rows {
        match row {
            Ok(r) => out.push(r),
            Err(e) => log::debug!("browse row error: {}", e),
        }
    }
    Ok(out)
}

// Browse files by category without a search word. "All" returns one section
// per present category (newest preview), otherwise a single category's list.
#[tauri::command]
async fn browse_files(
    app_handle: AppHandle,
    category: String,
) -> Result<Vec<BrowseSection>, String> {
    let pool = app_handle.state::<db::DbPool>();
    let conn = pool.get().map_err(|_| "DB pool error".to_string())?;

    let category_count = |conn: &rusqlite::Connection, cat: &str| -> usize {
        conn.query_row(
            "SELECT COUNT(*) FROM file_metadata WHERE category = ?1",
            params![cat],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        .max(0) as usize
    };

    if category != "All" {
        let files = browse_category_files(&conn, &category, BROWSE_LIMIT)?;
        return Ok(vec![BrowseSection {
            count: category_count(&conn, &category),
            category,
            files,
        }]);
    }

    let mut existing: Vec<String> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT DISTINCT category FROM file_metadata")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for cat in rows.flatten() {
            if !existing.contains(&cat) {
                existing.push(cat);
            }
        }
    }

    let ordered = order_browse_categories(existing);

    let mut sections = Vec::new();
    for cat in ordered {
        let files = browse_category_files(&conn, &cat, BROWSE_SECTION_LIMIT)?;
        sections.push(BrowseSection {
            count: category_count(&conn, &cat),
            category: cat,
            files,
        });
    }

    Ok(sections)
}

// Canonical section order, matching the category filter buttons; any unknown
// category (e.g. a future "Other" bucket) is appended last.
fn order_browse_categories(existing: Vec<String>) -> Vec<String> {
    const CANONICAL: [&str; 9] = [
        "Music",
        "Videos",
        "Programs",
        "Images",
        "Documents",
        "Archives",
        "Code",
        "Folder",
        "Other",
    ];
    let mut ordered: Vec<String> = CANONICAL
        .iter()
        .filter(|cat| existing.iter().any(|c| c == *cat))
        .map(|cat| cat.to_string())
        .collect();
    for cat in existing {
        if !ordered.contains(&cat) {
            ordered.push(cat);
        }
    }
    ordered
}

#[cfg(test)]
mod tests {
    use super::order_browse_categories;
    use super::path_is_indexed;
    use crate::db;
    use tempfile::tempdir;

    #[test]
    fn delete_only_targets_indexed_files() {
        let dir = tempdir().unwrap();
        let conn = db::setup_db(&dir.path().to_path_buf()).unwrap();
        conn.execute(
            "INSERT INTO file_metadata (path, mtime, size) VALUES (?1, 0, 0)",
            rusqlite::params!["/scanned/report.pdf"],
        )
        .unwrap();

        // A file the user actually found via search is deletable.
        assert!(path_is_indexed(&conn, "/scanned/report.pdf", "/scanned/report.pdf").unwrap());
        // Matches the raw input too, in case the scanner stored a different form.
        assert!(path_is_indexed(&conn, "/canonical/x", "/scanned/report.pdf").unwrap());

        // Anything outside the index is refused, which is what stops a
        // compromised webview turning delete_file into arbitrary-file-delete.
        for unindexed in [
            "/Windows/System32/hal.dll",
            "/etc/passwd",
            "/some/random/place",
        ] {
            assert!(
                !path_is_indexed(&conn, unindexed, unindexed).unwrap(),
                "unexpectedly allowed: {unindexed}"
            );
        }
    }

    #[test]
    fn orders_categories_in_canonical_order() {
        let ordered = order_browse_categories(vec![
            "Images".to_string(),
            "Music".to_string(),
            "Code".to_string(),
        ]);
        assert_eq!(ordered, vec!["Music", "Images", "Code"]);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn cloud_placeholder_attributes_are_detected() {
        assert!(super::is_cloud_placeholder_bits(0x0040_0000)); // RECALL_ON_DATA_ACCESS
        assert!(super::is_cloud_placeholder_bits(0x0000_1000)); // OFFLINE
        assert!(super::is_cloud_placeholder_bits(0x0004_0000)); // RECALL_ON_OPEN
                                                                // Unrelated flags set alongside a placeholder bit must not hide it.
        assert!(super::is_cloud_placeholder_bits(0x0004_0000 | 0x0020)); // + ARCHIVE
                                                                         // A local file with only regular attributes is not a placeholder.
        assert!(!super::is_cloud_placeholder_bits(0x0020));
        assert!(!super::is_cloud_placeholder_bits(0));
    }

    #[test]
    fn fts_snippet_highlights_a_match_inside_file_content() {
        let dir = tempdir().unwrap();
        let conn = db::setup_db(&dir.path().to_path_buf()).unwrap();

        // Title and path carry none of the query terms; only the body text
        // does. The snippet must therefore come from the content column.
        conn.execute(
            "INSERT INTO file_index (title, path, content)
             VALUES ('meeting notes', 'C:/docs/meeting notes.txt',
                     'meeting notes C:/docs/meeting notes.txt invoice total was 42 dollars and the client asked to confirm the final invoice amount before Friday')",
            [],
        )
        .unwrap();

        let sql = "SELECT file_index.rowid,
               COALESCE(
                   snippet(file_index, -1, '<b>', '</b>', '...', 12),
                   'The file matched your search'
               )
           FROM file_index
           WHERE file_index MATCH ?1
           ORDER BY rank, file_index.rowid";
        let snippet: String = conn
            .prepare(sql)
            .unwrap()
            .query_row(rusqlite::params!["\"invoice\""], |row| {
                row.get::<_, String>(1)
            })
            .unwrap();

        assert!(snippet.contains("<b>invoice</b>"), "got: {snippet}");
        // A leading ellipsis means the window starts mid-text, i.e. inside the
        // body around the match. A snippet window anchored at the file title
        // would produce no ellipsis before the first token.
        assert!(snippet.starts_with("..."), "got: {snippet}");
    }

    #[test]
    fn fts_bm25_weights_favor_title_over_content() {
        let dir = tempdir().unwrap();
        let conn = db::setup_db(&dir.path().to_path_buf()).unwrap();

        // File A: "budget" in title
        conn.execute(
            "INSERT INTO file_index (title, path, content)
             VALUES ('quarterly_budget.xlsx', 'C:/docs/quarterly_budget.xlsx', 'quarterly_budget.xlsx C:/docs/quarterly_budget.xlsx generic numbers and tables')",
            [],
        )
        .unwrap();

        // File B: "budget" repeated 15 times in content only
        let repeated = "budget ".repeat(15);
        conn.execute(
            "INSERT INTO file_index (title, path, content)
             VALUES ('random_log.txt', 'C:/docs/random_log.txt', ?1)",
            rusqlite::params![format!("random_log.txt C:/docs/random_log.txt {repeated}")],
        )
        .unwrap();

        let sql = "SELECT file_index.title, bm25(file_index, 10.0, 5.0, 1.0)
                   FROM file_index
                   WHERE file_index MATCH '\"budget\"'
                   ORDER BY bm25(file_index, 10.0, 5.0, 1.0), file_index.rowid";
        let mut stmt = conn.prepare(sql).unwrap();
        let titles: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(titles.len(), 2);
        assert_eq!(titles[0], "quarterly_budget.xlsx");
        assert_eq!(titles[1], "random_log.txt");
    }

    #[test]
    fn fts_preserves_short_token_filters() {
        let (fts_query, short_terms, filter_sql) = super::parse_fts_query("report v1", true);
        assert_eq!(fts_query, "\"report\"");
        assert_eq!(short_terms, vec!["%v1%"]);
        assert!(filter_sql.contains("LIKE ?2"));
        assert!(filter_sql.contains("LIKE ?3"));
    }

    #[test]
    fn parses_structured_query_operators() {
        let q = super::parse_structured_query("invoice ext:pdf folder:finance size:>10mb");
        assert_eq!(q.text_query, "invoice");
        assert_eq!(q.ext, Some("pdf".to_string()));
        assert_eq!(q.folder, Some("finance".to_string()));
        assert_eq!(q.min_size, Some(10 * 1024 * 1024));
        assert_eq!(q.max_size, None);
        assert!(q.has_filters());
        let clauses = q.to_sql_clauses();
        assert!(clauses.contains("f.title LIKE '%.pdf'"));
        assert!(clauses.contains("f.path LIKE '%finance%'"));
        assert!(clauses.contains("m.size >= 10485760"));
    }

    #[test]
    fn parses_size_strings_correctly() {
        assert_eq!(super::parse_size_str("500b"), Some(500));
        assert_eq!(super::parse_size_str("2kb"), Some(2048));
        assert_eq!(super::parse_size_str("5mb"), Some(5242880));
        assert_eq!(super::parse_size_str("1gb"), Some(1073741824));
    }

    #[test]
    fn hashes_duplicate_files_identically() {
        let dir = tempfile::tempdir().unwrap();
        let path_a = dir.path().join("a.txt");
        let path_b = dir.path().join("b.txt");
        let path_c = dir.path().join("c.txt");
        std::fs::write(&path_a, b"identical duplicate content 123").unwrap();
        std::fs::write(&path_b, b"identical duplicate content 123").unwrap();
        std::fs::write(&path_c, b"different content 456").unwrap();

        let hash_a = super::hash_file_bytes(&path_a).unwrap();
        let hash_b = super::hash_file_bytes(&path_b).unwrap();
        let hash_c = super::hash_file_bytes(&path_c).unwrap();

        assert_eq!(hash_a, hash_b);
        assert_ne!(hash_a, hash_c);
    }

    #[test]
    fn appends_unknown_categories_last() {
        let ordered = order_browse_categories(vec![
            "Weird".to_string(),
            "Images".to_string(),
            "Other".to_string(),
        ]);
        assert_eq!(ordered, vec!["Images", "Other", "Weird"]);
    }

    #[test]
    fn handles_empty_input() {
        assert!(order_browse_categories(Vec::new()).is_empty());
    }

    #[test]
    fn dangerous_executables_are_detected() {
        assert!(super::is_dangerous_executable(std::path::Path::new(
            "malware.exe"
        )));
        assert!(super::is_dangerous_executable(std::path::Path::new(
            "script.bat"
        )));
        assert!(super::is_dangerous_executable(std::path::Path::new(
            "command.ps1"
        )));
        assert!(super::is_dangerous_executable(std::path::Path::new(
            "install.sh"
        )));
        assert!(!super::is_dangerous_executable(std::path::Path::new(
            "document.pdf"
        )));
        assert!(!super::is_dangerous_executable(std::path::Path::new(
            "photo.png"
        )));
        assert!(!super::is_dangerous_executable(std::path::Path::new(
            "notes.txt"
        )));
    }
}

use sysinfo::Disks;

pub(crate) fn disk_is_pro_only(path: &std::path::Path) -> bool {
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
async fn get_system_drives() -> Result<Vec<DriveInfo>, String> {
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
async fn get_directories(path: String) -> Result<Vec<DirEntry>, String> {
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

/// True when `path` is a file this install has indexed.
///
/// Both the canonicalized path and the raw input are matched because the index
/// stores whichever form the scanner produced.
fn path_is_indexed(
    conn: &rusqlite::Connection,
    canonical: &str,
    raw: &str,
) -> rusqlite::Result<bool> {
    fn unprefix(s: &str) -> &str {
        s.strip_prefix(r"\\?\").unwrap_or(s)
    }
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM file_metadata WHERE path = ?1 OR path = ?2 OR path = ?3 OR path = ?4",
        params![canonical, raw, unprefix(canonical), unprefix(raw)],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

#[tauri::command]
async fn delete_file(app_handle: AppHandle, path: String) -> Result<String, String> {
    // Files indexed from a picked folder (Android, no All Files Access) are
    // `content://` documents. Vexil only holds read permission for those trees
    // and has no way to move them to Trash, so refuse clearly rather than
    // deleting irrecoverably or failing with a cryptic path error.
    if path.starts_with("content://") {
        return Err(
            "This file is inside a picked folder. Grant All Files Access to manage it.".to_string(),
        );
    }

    let allowed = security::AllowedRoots::new(true);
    let valid_path = allowed
        .validate(&path)
        .map_err(|e| format!("Security: {}", e))?;

    // Defence in depth behind the UI confirmation: only files this app actually
    // indexed can be deleted. `AllowedRoots::new(true)` permits any absolute
    // path by design, and the frontend confirmation is skipped entirely by a
    // compromised webview, so without this the delete command is an
    // arbitrary-file-delete primitive.
    //
    // Costs legitimate users nothing: a path outside the index cannot appear in
    // search results or browse sections, so there is no way to select one. Both
    // the canonical path and the raw input are matched because the index stores
    // whichever form the scanner produced.
    let canonical = valid_path.to_string_lossy().to_string();
    let pool = app_handle.state::<db::DbPool>();
    let conn = pool.get().map_err(|_| "DB pool error".to_string())?;
    if !path_is_indexed(&conn, &canonical, &path).map_err(|e| format!("Security: {}", e))? {
        return Err(
            "Security: refusing to delete a file that is not in the Vexil index".to_string(),
        );
    }

    // Moved rather than erased, so it can be restored from the Trash panel. The
    // OS recycle bin was not an option: it has no Android or iOS backend, and
    // restoring through the file manager is not reachable from the app.
    let name = valid_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| canonical.clone());
    trash::move_to_trash(&pool, &trash::trash_dir(&app_handle), &valid_path)
        .map_err(|e| format!("Could not move to trash: {e}"))?;

    // Drop it from the index so it stops appearing in results and browse
    // sections. A restore puts the file back on disk, and the live file watcher
    // picks it up again from there. Match both the canonical and raw forms, the
    // same pair `path_is_indexed` used to allow the delete: the scanner may have
    // stored either, so deleting only the canonical form would leave a ghost row.
    let _ = conn.execute(
        "DELETE FROM file_index WHERE path = ?1 OR path = ?2",
        params![canonical, path],
    );
    let _ = conn.execute(
        "DELETE FROM file_metadata WHERE path = ?1 OR path = ?2",
        params![canonical, path],
    );

    Ok(format!("Moved \"{name}\" to Trash"))
}

/// Everything currently in the Trash panel, newest first.
#[tauri::command]
async fn trash_items(app_handle: AppHandle) -> Result<Vec<trash::TrashItem>, String> {
    let pool = app_handle.state::<db::DbPool>();
    trash::list(&pool)
}

/// Puts a trashed file back where it came from. Returns the path it landed on.
#[tauri::command]
async fn restore_trashed_file(app_handle: AppHandle, id: i64) -> Result<String, String> {
    let pool = app_handle.state::<db::DbPool>();
    trash::restore(&pool, id)
}

/// Permanently deletes everything in the trash.
#[tauri::command]
async fn empty_trash(app_handle: AppHandle) -> Result<String, String> {
    let pool = app_handle.state::<db::DbPool>();
    let removed = trash::empty(&pool)?;
    Ok(match removed {
        0 => "Trash was already empty".to_string(),
        1 => "1 file permanently deleted".to_string(),
        n => format!("{n} files permanently deleted"),
    })
}

#[tauri::command]
async fn open_in_explorer(app_handle: AppHandle, path: String) -> Result<String, String> {
    let allowed = security::AllowedRoots::new(true);
    let valid_path = allowed
        .validate(&path)
        .map_err(|e| format!("Security: {}", e))?;

    let canonical = valid_path.to_string_lossy().to_string();
    let pool = app_handle.state::<db::DbPool>();
    let conn = pool.get().map_err(|_| "DB pool error".to_string())?;
    if !path_is_indexed(&conn, &canonical, &path).map_err(|e| format!("Security: {}", e))? {
        return Err("Security: refusing to open a file that is not in the Vexil index".to_string());
    }

    opener::reveal(&valid_path).map_err(|e| e.to_string())?;
    Ok("Opened".to_string())
}

/// Opens a file in the OS default handler for its type (video player, image
/// viewer, PDF reader, ...).
///
/// Android goes through the `MainActivity` JS bridge, which owns the
/// FileProvider/`ACTION_VIEW` plumbing, so this command only has to serve
/// desktop and iOS; `openResult` in the frontend prefers the bridge when it is
/// present.
#[cfg(any(desktop, test))]
fn is_dangerous_executable(path: &std::path::Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    matches!(
        ext.as_str(),
        "exe"
            | "msi"
            | "bat"
            | "cmd"
            | "com"
            | "scr"
            | "pif"
            | "vbs"
            | "vbe"
            | "wsf"
            | "wsh"
            | "ps1"
            | "psm1"
            | "sh"
            | "bash"
    )
}

#[tauri::command]
async fn open_file_external(
    app: AppHandle,
    path: String,
    allow_execute: Option<bool>,
) -> Result<String, String> {
    let valid_path = open_target_path(&app, &path)?;
    #[cfg(desktop)]
    if is_dangerous_executable(&valid_path) && !allow_execute.unwrap_or(false) {
        opener::reveal(&valid_path).map_err(|e| e.to_string())?;
        return Ok("Revealed executable safely in file explorer".to_string());
    }
    #[cfg(not(desktop))]
    let _ = allow_execute;
    open_with_default_app(&app, &valid_path)
}

/// Resolves `path` against the allowed roots and confirms it is an existing
/// file, so no platform ever hands an arbitrary path to the OS.
fn open_target_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let allowed = security::AllowedRoots::new(true);
    let valid_path = allowed
        .validate(path)
        .map_err(|e| format!("Security: {}", e))?;

    // `validate` canonicalizes, so a missing file already failed above; this
    // catches directories, which canonicalize fine but have no default handler.
    if !valid_path.is_file() {
        return Err(format!("Not a file: {}", valid_path.display()));
    }

    let canonical = valid_path.to_string_lossy().to_string();
    let pool = app.state::<db::DbPool>();
    let conn = pool.get().map_err(|_| "DB pool error".to_string())?;
    if !path_is_indexed(&conn, &canonical, path).map_err(|e| format!("Security: {}", e))? {
        return Err("Security: refusing to open a file that is not in the Vexil index".to_string());
    }

    Ok(valid_path)
}

#[cfg(desktop)]
fn open_with_default_app(_app: &AppHandle, path: &std::path::Path) -> Result<String, String> {
    opener::open(path).map_err(|e| e.to_string())?;
    Ok("Opened".to_string())
}

/// iOS hands the file to the Swift `VexilPlugin`, which drives a
/// `UIDocumentInteractionController` so the user can open it in another app.
#[cfg(target_os = "ios")]
fn open_with_default_app(app: &AppHandle, path: &std::path::Path) -> Result<String, String> {
    // `AppHandle` defaults to `Wry`, which is the runtime iOS uses too, so the
    // state type has to be spelled out: the `_` cannot be inferred here.
    app.state::<ios_open::Vexil<tauri::Wry>>()
        .open_file(path.to_path_buf())
        .map(|()| "Opened".to_string())
}

#[cfg(all(mobile, not(target_os = "ios")))]
fn open_with_default_app(_app: &AppHandle, _path: &std::path::Path) -> Result<String, String> {
    // Android opens through the `MainActivity` JS bridge, which owns the
    // FileProvider/ACTION_VIEW plumbing; the frontend uses it instead of this
    // command, so getting here means the bridge was missing.
    Err("Opening files in another app needs the Android bridge, which is unavailable.".to_string())
}

#[tauri::command]
fn set_run_in_background(app_handle: AppHandle, enable: bool) -> Result<String, String> {
    if enable && !license::has_feature(&app_handle, license::FEATURE_BACKGROUND) {
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

/// Aborts startup with a visible, actionable message instead of a panic.
///
/// A bare `expect` unwinds and, in the packaged Windows build, is surfaced as a
/// silent no-op: the window never opens and the user gets no explanation. Show
/// a native error dialog on desktop (blocking_show is desktop-only), log on
/// every platform, then exit with a non-zero code.
#[cfg_attr(not(desktop), allow(unused_variables))]
fn fatal_startup(app: &AppHandle, message: &str) -> ! {
    log::error!("Fatal startup error: {message}");
    #[cfg(desktop)]
    {
        use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
        app.dialog()
            .message(message)
            .kind(MessageDialogKind::Error)
            .title("Vexil could not start")
            .blocking_show();
    }
    std::process::exit(1);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `mut` is only needed when the e2e feature re-assigns builder below
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(ios_open::init());

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_global_shortcut::Builder::new().build())
            .plugin(tauri_plugin_updater::Builder::new().build());
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

            let app_dir = match app.path().app_data_dir() {
                Ok(dir) => dir,
                Err(e) => fatal_startup(
                    app.handle(),
                    &format!("Could not resolve the app data folder: {e}"),
                ),
            };
            if let Err(e) = setup_db(&app_dir) {
                fatal_startup(
                    app.handle(),
                    &format!("Failed to initialize the database: {e}"),
                );
            }

            // Create connection pool (4 connections for concurrent reads)
            let manager = r2d2_sqlite::SqliteConnectionManager::file(db_path(&app_dir))
                .with_init(|c| {
                    c.pragma_update(None, "journal_mode", "WAL")?;
                    c.pragma_update(None, "synchronous", "NORMAL")?;
                    // Match `open_db`: wait out a concurrent writer rather than
                    // surfacing SQLITE_BUSY to the user.
                    c.busy_timeout(std::time::Duration::from_secs(5))?;
                    db::register_regexp(c)?;
                    Ok(())
                });
            let pool = match r2d2::Pool::builder().max_size(4).build(manager) {
                Ok(pool) => pool,
                Err(e) => fatal_startup(
                    app.handle(),
                    &format!("Failed to open the database: {e}"),
                ),
            };
            app.manage(pool);

            // Clear out trash that has outlived the retention window, so a device
            // that is never short on storage cannot accumulate deleted files
            // forever. Best-effort: failing to tidy up must not stop startup.
            if let Err(e) = trash::purge_expired(&app.state::<db::DbPool>()) {
                log::warn!("Trash cleanup skipped: {e}");
            }

            app.manage(AppState {
                run_in_background: Mutex::new(false),
            });

            #[cfg(desktop)]
            {
                // Live Radar: Live File System Watcher
                let app_handle = app.handle().clone();
                let db_path_clone = db_path(&app_dir);

                thread::spawn(move || {
                    let (tx, rx) = channel();
                    let mut watcher = match notify::recommended_watcher(tx) {
                        Ok(w) => w,
                        Err(_) => return,
                    };

                    let mut roots_to_watch: Vec<PathBuf> = Vec::new();
                    if let Some(dl_dir) = dirs::download_dir() {
                        roots_to_watch.push(dl_dir);
                    }
                    if let Some(doc_dir) = dirs::document_dir() {
                        if !roots_to_watch.contains(&doc_dir) {
                            roots_to_watch.push(doc_dir);
                        }
                    }
                    if let Some(desk_dir) = dirs::desktop_dir() {
                        if !roots_to_watch.contains(&desk_dir) {
                            roots_to_watch.push(desk_dir);
                        }
                    }
                    if let Some(pic_dir) = dirs::picture_dir() {
                        if !roots_to_watch.contains(&pic_dir) {
                            roots_to_watch.push(pic_dir);
                        }
                    }
                    if let Some(vid_dir) = dirs::video_dir() {
                        if !roots_to_watch.contains(&vid_dir) {
                            roots_to_watch.push(vid_dir);
                        }
                    }
                    if let Some(music_dir) = dirs::audio_dir() {
                        if !roots_to_watch.contains(&music_dir) {
                            roots_to_watch.push(music_dir);
                        }
                    }
                    for r in mobile::raw_scan_roots(&app_handle) {
                        if !roots_to_watch.contains(&r) && r.is_dir() {
                            roots_to_watch.push(r);
                        }
                    }
                    for root in &roots_to_watch {
                        let _ = watcher.watch(root, RecursiveMode::Recursive);
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
                                    let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);

                                    let mut text_content = String::new();
                                    // Same rule as the scanner: a cloud placeholder's
                                    // body must not be read (it would hydrate the
                                    // real file over the network during a live watch).
                                    let placeholder = metadata
                                        .as_ref()
                                        .map(is_cloud_placeholder)
                                        .unwrap_or(false);
                                    if content::should_index_content(ext) && !placeholder {
                                        text_content = content::extract_text(&path, ext);
                                    }
                                    let content_str = format!("{} {} {}", title_str, path_str, text_content);

                                    let _ = conn.execute("DELETE FROM file_index WHERE path = ?1", params![&path_str]);
                                    let _ = conn.execute("INSERT INTO file_index (title, path, content) VALUES (?1, ?2, ?3)", params![&title_str, &path_str, &content_str]);

                                    // Upsert metadata with the file's category. Stamp
                                    // the change with the current time so the stale
                                    // GC (which only removes stamps older than a
                                    // scan's start) keeps this row, including for a
                                    // file created or edited while a scan is running.
                                    let live_sync_id = std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .map(|d| d.as_secs() as i64)
                                        .unwrap_or(mtime);
                                    let _ = conn.execute(
                                        "INSERT INTO file_metadata (path, mtime, size, sync_id, category) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, category = excluded.category, sync_id = excluded.sync_id",
                                        params![&path_str, mtime, size as i64, live_sync_id, &category],
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
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_platform,
            start_indexing,
            search_files,
            search_count,
            browse_files,
            delete_file,
            trash_items,
            restore_trashed_file,
            empty_trash,
            get_system_drives,
            get_directories,
            open_in_explorer,
            open_file_external,
            get_index_stats,
            set_run_in_background,
            exit_app,
            mobile::get_mobile_roots,
            mobile::add_mobile_root,
            mobile::remove_mobile_root,
            mobile::import_mobile_files,
            license::get_license_status,
            license::get_entitlements,
            license::install_license,
            license::get_device_id,
            license::activate_with_email,
            license::verify_activation,
            license::remove_license,
            updates::check_for_updates,
            updates::install_update,
            list_my_picks,
            add_my_pick,
            remove_my_pick,
            cancel_indexing,
            get_file_preview,
            find_duplicates
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
        .unwrap_or_else(|e| {
            log::error!("error while running tauri application: {e}");
            std::process::exit(1);
        });
}
