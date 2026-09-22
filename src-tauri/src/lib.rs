use rusqlite::{params, Connection, Result as SqlResult};
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Manager, State};
use walkdir::WalkDir;

#[derive(Serialize, Clone)]
pub struct SearchResult {
    pub id: u32,
    pub title: String,
    pub snippet: String,
    pub path: String,
    pub relevance: u8,
}

struct DbConnection(Arc<Mutex<Connection>>);

static INDEXING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn db_path(app_dir: &PathBuf) -> PathBuf {
    app_dir.join("vexil_index.db")
}

fn open_db(path: &PathBuf) -> SqlResult<Connection> {
    let conn = Connection::open(path)?;
    // WAL mode allows the indexer and searches to work concurrently
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(conn)
}

fn setup_db(app_dir: &PathBuf) -> SqlResult<Connection> {
    fs::create_dir_all(app_dir).unwrap_or_default();
    let conn = open_db(&db_path(app_dir))?;

    conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS file_index USING fts5(
            title,
            path,
            content,
            tokenize = 'porter'
        )",
        [],
    )?;

    Ok(conn)
}

// Directories that are never worth indexing
fn is_junk_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules"
            | ".git"
            | ".svn"
            | "target"
            | ".cache"
            | "__pycache__"
            | ".venv"
            | "venv"
    )
}

#[tauri::command]
fn start_indexing(app_handle: AppHandle) -> String {
    // Skip if an index run is already in progress (also guards React StrictMode double-invoke)
    if INDEXING.load(std::sync::atomic::Ordering::SeqCst) {
        return "Indexing already in progress".to_string();
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
                return "DB lock failed".to_string();
            }
        };
        match conn.query_row("PRAGMA database_list", [], |row| {
            row.get::<_, String>(2)
        }) {
            Ok(file) => PathBuf::from(file),
            Err(_) => {
                INDEXING.store(false, std::sync::atomic::Ordering::SeqCst);
                return "Failed to locate database".to_string();
            }
        }
    };

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

        let _ = conn.execute("DELETE FROM file_index", []);

        let mut dirs_to_scan = Vec::new();
        if let Some(doc_dir) = dirs::document_dir() {
            dirs_to_scan.push(doc_dir);
        }
        if let Some(dl_dir) = dirs::download_dir() {
            dirs_to_scan.push(dl_dir);
        }

        use tauri::Emitter;
        let mut count: i64 = 0;
        const BATCH: usize = 500;

        for base_dir in dirs_to_scan {
            let walker = WalkDir::new(base_dir)
                .into_iter()
                .filter_entry(|e| {
                    !e.file_type().is_dir() || !is_junk_dir(&e.file_name().to_string_lossy())
                })
                .filter_map(|e| e.ok());

            let mut batch: Vec<(String, String, String)> = Vec::with_capacity(BATCH);

            for entry in walker {
                if !entry.file_type().is_file() {
                    continue;
                }
                let path_str = entry.path().to_string_lossy().to_string();
                let title_str = entry.file_name().to_string_lossy().to_string();
                let content_str = format!("{} {}", title_str, path_str);

                batch.push((title_str, path_str, content_str));

                if batch.len() >= BATCH {
                    let _ = conn.execute_batch("BEGIN");
                    for (t, p, c) in batch.drain(..) {
                        let _ = conn.execute(
                            "INSERT INTO file_index (title, path, content) VALUES (?1, ?2, ?3)",
                            params![t, p, c],
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
                for (t, p, c) in batch.drain(..) {
                    let _ = conn.execute(
                        "INSERT INTO file_index (title, path, content) VALUES (?1, ?2, ?3)",
                        params![t, p, c],
                    );
                }
                let _ = conn.execute_batch("COMMIT");
            }
        }

        done(count);
    });

    "Indexing started in the background".to_string()
}

#[tauri::command]
fn search_files(app_handle: AppHandle, query: String) -> Result<Vec<SearchResult>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }

    let state = app_handle.state::<DbConnection>();
    let conn = state.0.lock().map_err(|_| "DB lock failed".to_string())?;

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
        .map(|term| format!("\"{}\"*", term.replace('"', "")))
        .collect();
    let fts_query = terms.join(" AND ");

    let results = stmt
        .query_map(params![fts_query], |row| {
            // bm25() returns negative scores (more negative = better match);
            // map to a friendly 1-100 percentage.
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

    let mut final_results = Vec::new();
    for res in results {
        if let Ok(r) = res {
            final_results.push(r);
        }
    }

    Ok(final_results)
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
            let conn = setup_db(&app_dir).expect("Failed to initialize database");
            app.manage(DbConnection(Arc::new(Mutex::new(conn))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![start_indexing, search_files])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
