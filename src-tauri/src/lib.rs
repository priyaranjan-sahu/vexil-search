mod security;

use notify::{Event, EventKind, RecursiveMode, Watcher};
use rusqlite::{params, Connection, Result as SqlResult};
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};
use walkdir::WalkDir;

mod db;

use db::{db_path, open_db, setup_db, DbConnection, SearchResult};

static INDEXING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// Directories that are never worth indexing
fn is_junk_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | ".git" | ".svn" | "target" | ".cache" | "__pycache__" | ".venv" | "venv"
    )
}

#[tauri::command]
fn start_indexing(
    app_handle: AppHandle,
    custom_dirs: Option<Vec<String>>,
    excluded_dirs: Option<Vec<String>>,
) -> Result<String, String> {
    // Skip if an index run is already in progress (also guards React StrictMode double-invoke)
    if INDEXING.load(std::sync::atomic::Ordering::SeqCst) {
        return Ok("Indexing already in progress".to_string());
    }
    INDEXING.store(true, std::sync::atomic::Ordering::SeqCst);

    let state: State<DbConnection> = app_handle.state();
    // Hold the shared connection only long enough to learn the DB location;
    // the worker opens its own connection so searches never block on the mutex.
    let path = {
        let conn = match state.0.lock() {
            Ok(c) => c,
            Err(_) => {
                INDEXING.store(false, std::sync::atomic::Ordering::SeqCst);
                return Err("DB lock failed".to_string());
            }
        };
        match conn.query_row("PRAGMA database_list", [], |row| row.get::<_, String>(2)) {
            Ok(file) => PathBuf::from(file),
            Err(_) => {
                INDEXING.store(false, std::sync::atomic::Ordering::SeqCst);
                return Err("Failed to locate database".to_string());
            }
        }
    };

    let mut valid_custom_dirs = Vec::new();
    if let Some(custom) = &custom_dirs {
        let allowed = security::AllowedRoots::new(true);
        let mut errors = Vec::new();
        for dir in custom {
            match allowed.validate(dir) {
                Ok(valid) => valid_custom_dirs.push(valid),
                Err(e) => errors.push(format!("'{}': {}", dir, e)),
            }
        }
        if !errors.is_empty() {
            INDEXING.store(false, std::sync::atomic::Ordering::SeqCst);
            return Err(format!("Invalid directories: {}", errors.join(", ")));
        }
    }

    let app_clone = app_handle.clone();

    thread::spawn(move || {
        let done = |count: i64| {
            use tauri::Emitter;
            let _ = app_clone.emit("indexing-done", count);
            INDEXING.store(false, std::sync::atomic::Ordering::SeqCst);
        };

        let conn = match open_db(&path) {
            Ok(c) => c,
            Err(_) => return done(0),
        };

        // Load existing files for incremental sync
        let mut existing_files = std::collections::HashMap::new();
        if let Ok(mut stmt) = conn.prepare("SELECT path, mtime FROM file_metadata") {
            if let Ok(rows) = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            }) {
                for row in rows.filter_map(|r| r.ok()) {
                    existing_files.insert(row.0, row.1);
                }
            }
        }
        let mut seen_files = std::collections::HashSet::new();

        let mut dirs_to_scan = Vec::new();
        if let Some(doc_dir) = dirs::document_dir() {
            dirs_to_scan.push(doc_dir);
        }
        if let Some(dl_dir) = dirs::download_dir() {
            dirs_to_scan.push(dl_dir);
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

        use tauri::Emitter;
        let mut count: i64 = 0;
        const BATCH: usize = 500;

        for base_dir in dirs_to_scan {
            let walker = WalkDir::new(base_dir)
                .into_iter()
                .filter_entry(|e| {
                    if exclusions.contains(e.path()) {
                        return false;
                    }
                    !e.file_type().is_dir() || !is_junk_dir(&e.file_name().to_string_lossy())
                })
                .filter_map(|e| e.ok());

            let mut batch: Vec<(String, String, String, i64)> = Vec::with_capacity(BATCH);

            for entry in walker {
                if !entry.file_type().is_file() {
                    continue;
                }
                let path_str = entry.path().to_string_lossy().to_string();
                let title_str = entry.file_name().to_string_lossy().to_string();

                let mtime = entry.metadata().ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                
                seen_files.insert(path_str.clone());

                if let Some(&old_mtime) = existing_files.get(&path_str) {
                    if old_mtime == mtime {
                        continue; // File unchanged
                    }
                    // Delete old record before updating
                    let _ = conn.execute("DELETE FROM file_index WHERE path = ?1", params![&path_str]);
                }

                let mut text_content = String::new();
                if let Some(ext) = entry.path().extension().and_then(|e| e.to_str()) {
                    if ["txt", "md", "csv", "json", "rs", "ts", "tsx", "js", "jsx"].contains(&ext) {
                        if let Ok(content) = std::fs::read_to_string(entry.path()) {
                            text_content = content.chars().take(2000).collect();
                        }
                    }
                }

                let content_str = format!("{} {} {}", title_str, path_str, text_content);

                batch.push((title_str, path_str, content_str, mtime));

                if batch.len() >= BATCH {
                    let _ = conn.execute_batch("BEGIN");
                    for (t, p, c, m) in batch.drain(..) {
                        let _ = conn.execute(
                            "INSERT INTO file_index (title, path, content) VALUES (?1, ?2, ?3)",
                            params![t, p, c],
                        );
                        let _ = conn.execute(
                            "INSERT OR REPLACE INTO file_metadata (path, mtime) VALUES (?1, ?2)",
                            params![p, m],
                        );
                    }
                    let _ = conn.execute_batch("COMMIT");
                }

                count += 1;
                if count % 100 == 0 {
                    let _ = app_clone.emit("indexing-progress", count);
                }
            }

            // flush remainder
            if !batch.is_empty() {
                let _ = conn.execute_batch("BEGIN");
                for (t, p, c, m) in batch {
                    let _ = conn.execute(
                        "INSERT INTO file_index (title, path, content) VALUES (?1, ?2, ?3)",
                        params![t, p, c],
                    );
                    let _ = conn.execute(
                        "INSERT OR REPLACE INTO file_metadata (path, mtime) VALUES (?1, ?2)",
                        params![p, m],
                    );
                }
                let _ = conn.execute_batch("COMMIT");
            }
        }

        // Stale file cleanup
        let _ = conn.execute_batch("BEGIN");
        for (path, _) in existing_files {
            if !seen_files.contains(&path) {
                let _ = conn.execute("DELETE FROM file_index WHERE path = ?1", params![&path]);
                let _ = conn.execute("DELETE FROM file_metadata WHERE path = ?1", params![&path]);
            }
        }
        let _ = conn.execute_batch("COMMIT");

        done(count);
    });

    Ok("Indexing started in the background".to_string())
}

#[tauri::command]
fn search_files(app_handle: AppHandle, query: String) -> Result<Vec<SearchResult>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }

    let state = app_handle.state::<DbConnection>();
    let conn = state.0.lock().map_err(|_| "DB lock failed".to_string())?;

    let is_regex = query.starts_with('/') && query.ends_with('/') && query.len() > 2;
    let mut final_results = Vec::new();

    if is_regex {
        let regex_pattern = &query[1..query.len() - 1];
        let sql = "
            SELECT rowid, title, path,
                   'Regex match found in path or title' as snippet,
                   100 as bm25
            FROM file_index
            WHERE path REGEXP ? OR title REGEXP ?
            LIMIT 50
        ";
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let results = stmt
            .query_map(params![regex_pattern, regex_pattern], |row| {
                Ok(SearchResult {
                    id: row.get::<_, u32>(0)?,
                    title: row.get::<_, String>(1)?,
                    path: row.get::<_, String>(2)?,
                    snippet: row.get::<_, String>(3)?,
                    relevance: 100,
                })
            })
            .map_err(|e| e.to_string())?;

        for res in results {
            if let Ok(r) = res {
                final_results.push(r);
            }
        }
    } else {
        let sql = "
            SELECT rowid, title, path,
                   snippet(file_index, 0, '<b>', '</b>', '...', 10),
                   bm25(file_index)
            FROM file_index
            WHERE file_index MATCH ?
            ORDER BY rank
            LIMIT 20
        ";

        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;

        // SQLite FTS syntax for prefix search; quote terms to avoid syntax errors on special characters
        let terms: Vec<String> = query
            .split_whitespace()
            .map(|term| {
                let safe_term = term.replace(|c: char| matches!(c, '"' | '*' | '(' | ')' | '+' | '-' | '~'), "");
                format!("\"{}\"*", safe_term)
            })
            .collect();
        let fts_query = terms.join(" AND ");

        let results = stmt
            .query_map(params![fts_query], |row| {
                let bm25: f64 = row.get::<_, f64>(4).unwrap_or(0.0);
                let relevance = (100.0 / (1.0 + bm25.abs() * 0.5)).clamp(1.0, 100.0) as u8;
                Ok(SearchResult {
                    id: row.get::<_, u32>(0)?,
                    title: row.get::<_, String>(1)?,
                    path: row.get::<_, String>(2)?,
                    snippet: row
                        .get::<_, String>(3)
                        .unwrap_or_else(|_| "File matched".to_string()),
                    relevance,
                })
            })
            .map_err(|e| e.to_string())?;

        for res in results {
            if let Ok(r) = res {
                final_results.push(r);
            }
        }
    }

    Ok(final_results)
}

#[tauri::command]
fn get_system_drives() -> Result<Vec<String>, String> {
    let mut drives = Vec::new();
    for c in b'A'..=b'Z' {
        let drive = format!("{}:\\", c as char);
        if std::path::Path::new(&drive).exists() {
            drives.push(drive);
        }
    }
    // Also include root `/` for unix systems if we are on one, though this looks windows specific.
    #[cfg(unix)]
    if std::path::Path::new("/").exists() && drives.is_empty() {
        drives.push("/".to_string());
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
    let valid_path = allowed.validate(&path).map_err(|e| format!("Security: {}", e))?;

    let mut dirs = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&valid_path) {
        for entry in entries.filter_map(|e| e.ok()) {
            if let Ok(file_type) = entry.file_type() {
                if file_type.is_dir() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let path_str = entry.path().to_string_lossy().to_string();
                    if !is_junk_dir(&name) {
                        dirs.push(DirEntry { name, path: path_str });
                    }
                }
            }
        }
    }
    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(dirs)
}

#[tauri::command]
fn delete_file(app_handle: AppHandle, path: String) -> Result<String, String> {
    let allowed = security::AllowedRoots::new(true);
    let valid_path = allowed.validate(&path).map_err(|e| format!("Security: {}", e))?;

    match fs::remove_file(&valid_path) {
        Ok(_) => {
            // Also remove from index
            let state = app_handle.state::<DbConnection>();
            if let Ok(conn) = state.0.lock() {
                let valid_path_str = valid_path.to_string_lossy().to_string();
                let _ = conn.execute("DELETE FROM file_index WHERE path = ?1", params![valid_path_str]);
            }
            Ok("File deleted".to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let conn = setup_db(&app_dir).expect("Failed to initialize database");
            app.manage(DbConnection(Arc::new(Mutex::new(conn))));

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
                loop {
                    let res = if pending_paths.is_empty() {
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
                        Some(_) => continue, // Ignore other events
                        None => {
                            if pending_paths.is_empty() {
                                // Channel disconnected and nothing pending
                                break;
                            }
                        }
                    }

                    // Timeout reached or channel disconnected with pending paths
                    if !pending_paths.is_empty() {
                        if let Ok(conn) = open_db(&db_path_clone) {
                            let mut processed_paths = Vec::new();
                            for path in pending_paths.drain() {
                                if path.is_file() {
                                    let path_str = path.to_string_lossy().to_string();
                                    if is_junk_dir(&path_str) {
                                        continue;
                                    }
                                    let title_str = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                                    let content_str = format!("{} {}", title_str, path_str);
                                    
                                    let _ = conn.execute("DELETE FROM file_index WHERE path = ?1", params![&path_str]);
                                    let _ = conn.execute("INSERT INTO file_index (title, path, content) VALUES (?1, ?2, ?3)", params![&title_str, &path_str, &content_str]);
                                    
                                    processed_paths.push(path_str);
                                }
                            }
                            if !processed_paths.is_empty() {
                                // Emit once per batch
                                let _ = app_handle.emit("live-radar-batch", processed_paths);
                            }
                        } else {
                            pending_paths.clear(); // Clear to avoid infinite loop on DB error
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_indexing,
            search_files,
            delete_file,
            get_system_drives,
            get_directories
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
