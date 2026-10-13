use rusqlite::{Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SearchResult {
    pub id: i64,
    pub title: String,
    pub snippet: String,
    pub path: String,
    pub relevance: u8,
    pub size: u64,
    pub modified: i64,
    pub category: String,
}

use r2d2_sqlite::SqliteConnectionManager;

pub type DbPool = r2d2::Pool<SqliteConnectionManager>;

pub fn db_path(app_dir: &std::path::Path) -> PathBuf {
    app_dir.join("vexil_index.db")
}

pub fn open_db(path: &std::path::Path) -> SqlResult<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    // Wait for a concurrent writer instead of failing immediately with
    // SQLITE_BUSY. The indexer, watcher and UI all write through separate
    // connections, so without this a brief overlap is a hard error.
    conn.busy_timeout(std::time::Duration::from_secs(5))?;

    register_regexp(&conn)?;

    Ok(conn)
}

/// Registers the `REGEXP` scalar function used by regex search.
///
/// SQLite invokes the function once per row, so compiling the pattern inside the
/// callback recompiled it for every candidate row (O(rows) regex builds, the
/// audit's 2.13). Memoise the compiled pattern per connection instead. The cache
/// is cleared once it holds `REGEXP_CACHE_MAX` distinct patterns, which bounds
/// memory for a long-lived connection while keeping the common single-pattern
/// query at one build.
pub fn register_regexp(conn: &Connection) -> SqlResult<()> {
    const REGEXP_CACHE_MAX: usize = 64;
    let cache: std::cell::RefCell<std::collections::HashMap<String, regex::Regex>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    conn.create_scalar_function(
        "REGEXP",
        2,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        move |ctx| {
            let expr = ctx.get::<String>(0)?;
            let s = ctx.get::<String>(1)?;
            let cached = cache.borrow().get(&expr).cloned();
            let re = match cached {
                Some(re) => re,
                None => {
                    if cache.borrow().len() >= REGEXP_CACHE_MAX {
                        cache.borrow_mut().clear();
                    }
                    let re = regex::RegexBuilder::new(&expr)
                        .size_limit(100_000)
                        .dfa_size_limit(1_000_000)
                        .build()
                        .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?;
                    cache.borrow_mut().insert(expr.clone(), re.clone());
                    re
                }
            };
            Ok(re.is_match(&s))
        },
    )
}

pub fn setup_db(app_dir: &PathBuf) -> SqlResult<Connection> {
    std::fs::create_dir_all(app_dir).unwrap_or_default();
    let conn = open_db(&db_path(app_dir))?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS file_metadata (
            path TEXT PRIMARY KEY,
            mtime INTEGER,
            size INTEGER
        )",
        [],
    )?;

    // Add columns for stateless garbage collection and size if they don't exist in older DB versions
    let _ = conn.execute(
        "ALTER TABLE file_metadata ADD COLUMN size INTEGER DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE file_metadata ADD COLUMN sync_id INTEGER DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE file_metadata ADD COLUMN category TEXT DEFAULT 'Other'",
        [],
    );

    conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS file_index USING fts5(
            title,
            path,
            content,
            tokenize='trigram'
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS my_picks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            size INTEGER NOT NULL DEFAULT 0,
            modified INTEGER NOT NULL DEFAULT 0,
            category TEXT NOT NULL DEFAULT 'Other',
            added_at INTEGER NOT NULL
        )",
        [],
    )?;

    // Small key/value store for app-owned singletons. Currently holds the
    // licence clock watermark, so it deliberately lives in the database rather
    // than alongside the other app files: clearing out the app data directory
    // does not clear it.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_state (
            key TEXT PRIMARY KEY,
            value INTEGER NOT NULL
        )",
        [],
    )?;

    // Files the user deleted, held in Vexil's own trash directory so they can be
    // restored. `original_path` is where the file came from and is what a restore
    // writes back to; `trash_path` is its current home under the trash directory.
    // Rows whose file has been purged are removed, so a missing trash_path here
    // means "restored, already restored, or emptied" rather than "lost silently".
    conn.execute(
        "CREATE TABLE IF NOT EXISTS trash (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            original_path TEXT NOT NULL,
            trash_path TEXT NOT NULL,
            name TEXT NOT NULL,
            size_bytes INTEGER NOT NULL DEFAULT 0,
            deleted_at INTEGER NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_trash_deleted_at ON trash(deleted_at)",
        [],
    )?;

    Ok(conn)
}

/// Reads an app-owned singleton, `None` when absent or unreadable.
pub fn get_app_state(pool: &DbPool, key: &str) -> Option<i64> {
    let conn = pool.get().ok()?;
    conn.query_row(
        "SELECT value FROM app_state WHERE key = ?1",
        rusqlite::params![key],
        |row| row.get(0),
    )
    .ok()
}

/// Writes an app-owned singleton, never lowering an existing value.
///
/// The monotonic guard means a rolled-back or edited clock cannot walk the
/// stored value backwards, so this stays a high-water mark even if the caller
/// passes a stale timestamp.
pub fn set_app_state(pool: &DbPool, key: &str, value: i64) {
    let Ok(conn) = pool.get() else { return };
    let _ = conn.execute(
        "INSERT INTO app_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = MAX(app_state.value, excluded.value)",
        rusqlite::params![key, value],
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_db_initialization() {
        let dir = tempdir().unwrap();

        let conn = setup_db(&dir.path().to_path_buf()).expect("Failed to init db");

        // Verify tables exist
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .unwrap();
        let tables: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert!(tables.contains(&"file_metadata".to_string()));
        assert!(tables.contains(&"file_index".to_string()));
        assert!(tables.contains(&"my_picks".to_string()));
        assert!(tables.contains(&"app_state".to_string()));
    }

    #[test]
    fn app_state_never_lowers_an_existing_value() {
        let dir = tempdir().unwrap();
        let app_dir = dir.path().to_path_buf();
        // Creates the schema, then hands the file to a pool like the app does.
        drop(setup_db(&app_dir).unwrap());
        let pool = r2d2::Pool::builder()
            .max_size(1)
            .build(r2d2_sqlite::SqliteConnectionManager::file(db_path(
                &app_dir,
            )))
            .unwrap();

        set_app_state(&pool, "license_seen_at", 1_700_000_000);
        assert_eq!(get_app_state(&pool, "license_seen_at"), Some(1_700_000_000));

        // A rolled-back or edited clock must not walk the high-water mark back.
        set_app_state(&pool, "license_seen_at", 1_000);
        assert_eq!(get_app_state(&pool, "license_seen_at"), Some(1_700_000_000));

        // Forward progress still lands.
        set_app_state(&pool, "license_seen_at", 1_800_000_000);
        assert_eq!(get_app_state(&pool, "license_seen_at"), Some(1_800_000_000));

        assert_eq!(get_app_state(&pool, "missing"), None);
    }

    #[test]
    fn my_picks_are_deduplicated_by_path() {
        let dir = tempdir().unwrap();
        let conn = setup_db(&dir.path().to_path_buf()).unwrap();
        let now = 1_700_000_000_i64;

        for _ in 0..2 {
            conn.execute(
                "INSERT OR IGNORE INTO my_picks (path, title, size, modified, category, added_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params!["/a/b.mp4", "b.mp4", 10_i64, 20_i64, "Video", now],
            )
            .unwrap();
        }

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM my_picks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "re-adding the same path must not duplicate");
    }

    #[test]
    fn my_picks_persist_order_and_survive_reopen() {
        let dir = tempdir().unwrap();
        let app_dir = dir.path().to_path_buf();
        let now = 1_700_000_000_i64;

        {
            let conn = setup_db(&app_dir).unwrap();
            for path in ["/a/1.mp4", "/a/2.mp4", "/a/3.mp4"] {
                conn.execute(
                    "INSERT INTO my_picks (path, title, size, modified, category, added_at)
                     VALUES (?1, ?2, 0, 0, 'Video', ?3)",
                    rusqlite::params![path, "t", now],
                )
                .unwrap();
            }
        }

        let conn = open_db(&db_path(&app_dir)).unwrap();
        let paths: Vec<String> = conn
            .prepare("SELECT path FROM my_picks ORDER BY added_at DESC, id DESC")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(paths, vec!["/a/3.mp4", "/a/2.mp4", "/a/1.mp4"]);
    }

    #[test]
    fn removing_a_pick_is_scoped_to_one_id() {
        let dir = tempdir().unwrap();
        let conn = setup_db(&dir.path().to_path_buf()).unwrap();

        conn.execute(
            "INSERT INTO my_picks (path, title, size, modified, category, added_at)
             VALUES ('/a/1.mp4', 'one', 0, 0, 'Video', 1)",
            [],
        )
        .unwrap();
        let id: i64 = conn
            .query_row(
                "SELECT id FROM my_picks WHERE path = '/a/1.mp4'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        let deleted = conn
            .execute("DELETE FROM my_picks WHERE id = ?1", rusqlite::params![id])
            .unwrap();

        assert_eq!(deleted, 1);
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM my_picks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 0);
    }
}
