use rusqlite::{Connection, Result as SqlResult};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Serialize, Clone)]
pub struct SearchResult {
    pub id: u32,
    pub title: String,
    pub snippet: String,
    pub path: String,
    pub relevance: u8,
}

pub struct DbConnection(pub Arc<Mutex<Connection>>);

pub fn db_path(app_dir: &PathBuf) -> PathBuf {
    app_dir.join("vexil_index.db")
}

pub fn open_db(path: &PathBuf) -> SqlResult<Connection> {
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
        "CREATE VIRTUAL TABLE IF NOT EXISTS file_index USING fts5(
            title,
            path,
            content,
            tokenize='trigram'
        )",
        [],
    )?;
    
    conn.execute(
        "CREATE TABLE IF NOT EXISTS file_metadata (
            path TEXT PRIMARY KEY,
            mtime INTEGER
        )",
        [],
    )?;

    Ok(conn)
}
