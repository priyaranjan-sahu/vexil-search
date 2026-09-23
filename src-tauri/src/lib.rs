mod security;

use notify::{Event, EventKind, RecursiveMode, Watcher};
use rusqlite::params;
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::mpsc::channel;
use std::thread;
use tauri::{AppHandle, Emitter, Manager};

mod db;

use db::{db_path, open_db, setup_db, SearchResult};

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

    let pool = app_handle.state::<db::DbPool>();
    let path = {
        let conn = match pool.get() {
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
        let start_time = std::time::Instant::now();
        println!("Indexing thread started");

        let done = |count: i64| {
            use tauri::Emitter;
            let _ = app_clone.emit("indexing-done", count);
            INDEXING.store(false, std::sync::atomic::Ordering::SeqCst);
            println!("Indexing done in {:?}", start_time.elapsed());
        };

        let mut conn = match open_db(&path) {
            Ok(c) => c,
            Err(_) => return done(0),
        };
        println!("DB opened in {:?}", start_time.elapsed());

        // Removed existing_files memory bottleneck!
        let sync_id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

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

        println!("WalkBuilder initialized in {:?}", start_time.elapsed());

        // Spawn parallel walker
        thread::spawn(move || {
            builder.build_parallel().run(|| {
                let tx = tx.clone();
                let exclusions = exclusions_arc.clone();
                Box::new(move |result| {
                    if let Ok(entry) = result {
                        if exclusions.contains(entry.path()) {
                            return ignore::WalkState::Skip;
                        }
                        if let Some(file_type) = entry.file_type() {
                            if file_type.is_dir()
                                && is_junk_dir(&entry.file_name().to_string_lossy())
                            {
                                return ignore::WalkState::Skip;
                            }
                            if file_type.is_file() {
                                let path_str = entry.path().to_string_lossy().to_string();
                                let title_str = entry.file_name().to_string_lossy().to_string();

                                let metadata = entry.metadata().ok();
                                let mtime = metadata
                                    .as_ref()
                                    .and_then(|m| m.modified().ok())
                                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                    .map(|d| d.as_secs() as i64)
                                    .unwrap_or(0);
                                let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);

                                let mut text_content = String::new();
                                if let Some(ext) = entry.path().extension().and_then(|e| e.to_str())
                                {
                                    if ["txt", "md", "csv", "json", "rs", "ts", "tsx", "js", "jsx"]
                                        .contains(&ext)
                                    {
                                        if let Ok(mut file) = fs::File::open(entry.path()) {
                                            // Read up to 2000 bytes without allocating the whole file
                                            let mut buffer = vec![0; 2000];
                                            if let Ok(bytes_read) = file.read(&mut buffer) {
                                                buffer.truncate(bytes_read);
                                                text_content =
                                                    String::from_utf8_lossy(&buffer).into_owned();
                                            }
                                        }
                                    }
                                }

                                let content_str =
                                    format!("{} {} {}", title_str, path_str, text_content);
                                let _ =
                                    tx.send((title_str, path_str, content_str, mtime, size as i64));
                            }
                        }
                    }
                    ignore::WalkState::Continue
                })
            });
        }); // tx is dropped here when parallel walker finishes

        let mut batch_insert: Vec<(String, String, String, i64, i64)> = Vec::with_capacity(BATCH);
        let mut batch_sync: Vec<String> = Vec::with_capacity(BATCH);

        let process_batches = |conn: &mut rusqlite::Connection,
                               b_insert: &mut Vec<(String, String, String, i64, i64)>,
                               b_sync: &mut Vec<String>| {
            if b_insert.is_empty() && b_sync.is_empty() {
                return;
            }
            let _ = conn.execute_batch("BEGIN");
            {
                if !b_insert.is_empty() {
                    let mut stmt_idx = conn
                        .prepare_cached(
                            "INSERT INTO file_index (title, path, content) VALUES (?1, ?2, ?3)",
                        )
                        .unwrap();
                    let mut stmt_meta = conn.prepare_cached("INSERT OR REPLACE INTO file_metadata (path, mtime, size, sync_id) VALUES (?1, ?2, ?3, ?4)").unwrap();
                    for (t, p, c, m, s) in b_insert.drain(..) {
                        let _ = stmt_idx.execute(params![t, p, c]);
                        let _ = stmt_meta.execute(params![p, m, s, sync_id]);
                    }
                }
                if !b_sync.is_empty() {
                    let mut stmt_update = conn
                        .prepare_cached("UPDATE file_metadata SET sync_id = ?1 WHERE path = ?2")
                        .unwrap();
                    for p in b_sync.drain(..) {
                        let _ = stmt_update.execute(params![sync_id, p]);
                    }
                }
            }
            let _ = conn.execute_batch("COMMIT");
        };

        let mut check_mtime = conn
            .prepare_cached("SELECT mtime FROM file_metadata WHERE path = ?1")
            .unwrap();
        let mut delete_idx = conn
            .prepare_cached("DELETE FROM file_index WHERE path = ?1")
            .unwrap();

        let mut first_file = true;

        while let Ok((t, p, c, m, s)) = rx.recv() {
            if first_file {
                println!(
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
                batch_insert.push((t, p, c, m, s));
            }

            if batch_insert.len() >= BATCH || batch_sync.len() >= BATCH {
                drop(check_mtime); // MUST drop prepared statements before processing batch due to connection mutability
                drop(delete_idx);
                process_batches(&mut conn, &mut batch_insert, &mut batch_sync);
                check_mtime = conn
                    .prepare_cached("SELECT mtime FROM file_metadata WHERE path = ?1")
                    .unwrap();
                delete_idx = conn
                    .prepare_cached("DELETE FROM file_index WHERE path = ?1")
                    .unwrap();
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
fn search_files(app_handle: AppHandle, query: String) -> Result<Vec<SearchResult>, String> {
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

    if short_query {
        let sql = "
            SELECT f.rowid, f.title, f.path,
                   'Matched in path or title' as snippet,
                   100 as bm25,
                   m.size, m.mtime
            FROM file_index f
            LEFT JOIN file_metadata m ON f.path = m.path
            WHERE f.path LIKE ? OR f.title LIKE ?
            LIMIT 50
        ";
        let pattern = format!("%{}%", trimmed_query);
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let results = stmt
            .query_map(params![pattern, pattern], |row| {
                Ok(SearchResult {
                    id: row.get::<_, u32>(0)?,
                    title: row.get::<_, String>(1)?,
                    path: row.get::<_, String>(2)?,
                    snippet: row.get::<_, String>(3)?,
                    relevance: 100,
                    size: row.get::<_, i64>(5).unwrap_or(0) as u64,
                    modified: row.get::<_, i64>(6).unwrap_or(0),
                })
            })
            .map_err(|e| e.to_string())?;

        for res in results {
            if let Ok(r) = res {
                final_results.push(r);
            } else if let Err(e) = res {
                println!("LIKE query row error: {}", e);
            }
        }
    } else if is_regex {
        let regex_pattern = &query[1..query.len() - 1];
        let sql = "
            SELECT f.rowid, f.title, f.path,
                   'Regex match found in path or title' as snippet,
                   100 as bm25,
                   m.size, m.mtime
            FROM file_index f
            LEFT JOIN file_metadata m ON f.path = m.path
            WHERE f.path REGEXP ? OR f.title REGEXP ?
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
                    size: row.get::<_, i64>(5).unwrap_or(0) as u64,
                    modified: row.get::<_, i64>(6).unwrap_or(0),
                })
            })
            .map_err(|e| e.to_string())?;

        for res in results {
            if let Ok(r) = res {
                final_results.push(r);
            } else if let Err(e) = res {
                println!("Regex query row error: {}", e);
            }
        }
    } else {
        let sql = "
            SELECT file_index.rowid, file_index.title, file_index.path,
                   snippet(file_index, 0, '<b>', '</b>', '...', 10),
                   bm25(file_index),
                   m.size, m.mtime
            FROM file_index
            LEFT JOIN file_metadata m ON file_index.path = m.path
            WHERE file_index MATCH ?
            ORDER BY rank
            LIMIT 50
        ";

        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;

        // SQLite FTS syntax for prefix search; quote terms to avoid syntax
        // errors on special characters and drop tokens trigram cannot match.
        let terms: Vec<String> = query
            .split_whitespace()
            .filter(|term| alnum_len(term) >= 3)
            .map(|term| {
                let safe_term = term.replace(
                    |c: char| matches!(c, '"' | '*' | '(' | ')' | '+' | '-' | '~'),
                    "",
                );
                format!("\"{}\"", safe_term)
            })
            .collect();
        let fts_query = terms.join(" AND ");

        let results = stmt
            .query_map(params![fts_query], |row| {
                let bm25: f64 = row.get::<_, f64>(4).unwrap_or(0.0);
                // Trigram tokenizer produces different BM25 ranges than porter.
                let relevance =
                    (100.0_f64 / (1.0_f64 + bm25.abs() * 0.15_f64)).clamp(1.0_f64, 100.0_f64) as u8;
                Ok(SearchResult {
                    id: row.get::<_, u32>(0)?,
                    title: row.get::<_, String>(1)?,
                    path: row.get::<_, String>(2)?,
                    snippet: row
                        .get::<_, String>(3)
                        .unwrap_or_else(|_| "File matched".to_string()),
                    relevance,
                    size: row.get::<_, i64>(5).unwrap_or(0) as u64,
                    modified: row.get::<_, i64>(6).unwrap_or(0),
                })
            })
            .map_err(|e| {
                println!("FTS query_map error: {}", e);
                e.to_string()
            })?;

        for res in results {
            if let Ok(r) = res {
                final_results.push(r);
            } else if let Err(e) = res {
                println!("FTS query row error: {}", e);
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
    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
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
            }
            Ok("File deleted".to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn open_in_explorer(path: String) -> Result<String, String> {
    opener::reveal(&path).map_err(|e| e.to_string())?;
    Ok("Opened".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
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

                                let metadata = std::fs::metadata(&path).ok();
                                let mtime = metadata
                                    .as_ref()
                                    .and_then(|m| m.modified().ok())
                                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                    .map(|d| d.as_secs() as i64)
                                    .unwrap_or(0);
                                let size = metadata.map(|m| m.len()).unwrap_or(0);

                                let mut text_content = String::new();
                                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                                    if ["txt", "md", "csv", "json", "rs", "ts", "tsx", "js", "jsx"].contains(&ext) {
                                        if let Ok(mut file) = fs::File::open(&path) {
                                            let mut buffer = vec![0; 2000];
                                            if let Ok(bytes_read) = file.read(&mut buffer) {
                                                buffer.truncate(bytes_read);
                                                text_content = String::from_utf8_lossy(&buffer).into_owned();
                                            }
                                        }
                                    }
                                }
                                let content_str = format!("{} {} {}", title_str, path_str, text_content);

                                let _ = conn.execute("DELETE FROM file_index WHERE path = ?1", params![&path_str]);
                                let _ = conn.execute("INSERT INTO file_index (title, path, content) VALUES (?1, ?2, ?3)", params![&title_str, &path_str, &content_str]);

                                // Update metadata if it exists (preserves sync_id), insert otherwise
                                let _ = conn.execute(
                                    "UPDATE file_metadata SET mtime = ?1, size = ?2 WHERE path = ?3",
                                    params![mtime, size as i64, &path_str],
                                );
                                if conn.changes() == 0 {
                                    let _ = conn.execute(
                                        "INSERT INTO file_metadata (path, mtime, size, sync_id) VALUES (?1, ?2, ?3, 0)",
                                        params![&path_str, mtime, size as i64],
                                    );
                                }

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
            start_indexing,
            search_files,
            delete_file,
            get_system_drives,
            get_directories,
            open_in_explorer
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
