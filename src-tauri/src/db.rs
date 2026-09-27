use rusqlite::{Connection, Result as SqlResult};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize, Clone)]
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

    conn.create_scalar_function(
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

    Ok(conn)
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

    Ok(conn)
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
    }
}
