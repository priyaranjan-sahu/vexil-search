use rusqlite::params;
use tauri::{AppHandle, Manager};

pub fn path_hash(canonical: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    hex::encode(hasher.finalize())
}

#[tauri::command]
pub fn create_delete_token(app_handle: AppHandle, path: String) -> Result<String, String> {
    let allowed = crate::security::AllowedRoots::new(true);
    let valid_path = allowed
        .validate(&path)
        .map_err(|e| format!("Security: {}", e))?;
    let canonical = valid_path.to_string_lossy().to_string();
    let pool = app_handle.state::<crate::db::DbPool>();
    let conn = pool.get().map_err(|_| "DB pool error".to_string())?;
    if !crate::path_is_indexed(&conn, &canonical, &path).map_err(|e| format!("Security: {}", e))? {
        return Err("Security: refusing to create delete token for non-indexed file".to_string());
    }
    let token = uuid::Uuid::new_v4().to_string();
    let ph = path_hash(&canonical);
    let expires_at = (chrono::Utc::now().timestamp() as i64) + 600;
    conn.execute(
        "INSERT OR REPLACE INTO delete_tokens(token, path_hash, expires_at, used) VALUES (?1, ?2, ?3, 0)",
        params![&token, &ph, expires_at],
    ).map_err(|e| format!("DB error: {}", e))?;
    Ok(token)
}

#[tauri::command]
pub fn consume_delete_token(
    app_handle: AppHandle,
    token: String,
    path: String,
) -> Result<bool, String> {
    let allowed = crate::security::AllowedRoots::new(true);
    let valid_path = allowed
        .validate(&path)
        .map_err(|e| format!("Security: {}", e))?;
    let canonical = valid_path.to_string_lossy().to_string();
    let pool = app_handle.state::<crate::db::DbPool>();
    let conn = pool.get().map_err(|_| "DB pool error".to_string())?;
    let now = chrono::Utc::now().timestamp() as i64;
    let ph = path_hash(&canonical);
    let res: rusqlite::Result<(i32, i64)> = conn.query_row(
        "SELECT used, expires_at FROM delete_tokens WHERE token = ?1 AND path_hash = ?2",
        params![&token, &ph],
        |r| Ok((r.get(0)?, r.get(1)?)),
    );
    match res {
        Ok((used, exp)) => {
            if used == 1 {
                return Ok(false);
            }
            if exp < now {
                return Ok(false);
            }
            conn.execute(
                "UPDATE delete_tokens SET used = 1 WHERE token = ?1",
                params![&token],
            )
            .map_err(|e| format!("DB error: {}", e))?;
            Ok(true)
        }
        Err(_) => Ok(false),
    }
}

pub fn validate_delete_token(
    app_handle: &AppHandle,
    token: &str,
    canonical: &str,
) -> Result<bool, String> {
    let pool = app_handle.state::<crate::db::DbPool>();
    let conn = pool.get().map_err(|_| "DB pool error".to_string())?;
    let now = chrono::Utc::now().timestamp() as i64;
    let ph = path_hash(canonical);
    let res: rusqlite::Result<(i32, i64)> = conn.query_row(
        "SELECT used, expires_at FROM delete_tokens WHERE token = ?1 AND path_hash = ?2",
        params![token, &ph],
        |r| Ok((r.get(0)?, r.get(1)?)),
    );
    match res {
        Ok((used, exp)) => {
            if used == 1 {
                return Ok(false);
            }
            if exp < now {
                return Ok(false);
            }
            conn.execute(
                "UPDATE delete_tokens SET used = 1 WHERE token = ?1",
                params![token],
            )
            .map_err(|e| format!("DB error: {}", e))?;
            Ok(true)
        }
        Err(_) => Ok(false),
    }
}
