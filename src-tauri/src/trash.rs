//! Vexil's own trash, so a deleted file can be put back.
//!
//! The OS recycle bin was the obvious choice and is not usable here: the `trash`
//! crate has no Android or iOS backend, and Vexil ships both. Shelling out to
//! Explorer, Finder and the Android Documents provider instead would mean three
//! unrelated restore paths, none of them reachable from inside the app, which is
//! where a user looks after deleting something by mistake.
//!
//! So every platform gets the same thing: the file is moved into a `.trash`
//! directory under the app's data directory and recorded in the `trash` table.
//! Restoring and emptying both work from the app UI on every platform, and the
//! logic is plain filesystem work that is unit-testable on any host.
//!
//! Trade-off worth stating plainly: files deleted here are recoverable through
//! Vexil, not through Explorer or Finder. The file leaves its original folder
//! either way, so a user who browses to the folder in their file manager will
//! not see it in a system bin.

use crate::db::DbPool;
use rusqlite::params;
use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// How long a deleted file stays restorable.
pub const RETENTION_DAYS: i64 = 30;

const TRASH_DIR: &str = ".trash";
const SECS_PER_DAY: i64 = 60 * 60 * 24;

/// A deleted file, as shown in the Trash panel.
#[derive(Debug, Clone, Serialize)]
pub struct TrashItem {
    pub id: i64,
    pub name: String,
    /// Where the file lived before deletion, shown so the user can tell similar
    /// filenames apart.
    pub original_path: String,
    pub size_bytes: i64,
    pub deleted_at: i64,
    /// Whole days left before this is purged automatically.
    pub days_left: i64,
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn trash_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(TRASH_DIR)
}

/// A destination name that cannot collide with an existing trashed file.
///
/// The original name is kept readable so the Trash panel shows something
/// recognisable, and the timestamp prefix makes the natural ordering match the
/// deletion order.
fn trash_filename(name: &str, deleted_at: i64) -> String {
    let safe: String = name
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c == ':' {
                '_'
            } else {
                c
            }
        })
        .collect();
    let safe = if safe.trim().is_empty() {
        "unnamed".to_string()
    } else {
        safe
    };
    format!("{deleted_at}_{safe}")
}

/// Moves `path` into the trash and records it.
///
/// Falls back to copy-then-delete when a rename is not possible, which is the
/// normal case on Android: an SD card is a different filesystem from the app's
/// private directory, so `rename` fails with EXDEV there. Without this, deleting
/// a file from an SD card would fail outright on the platform where removable
/// storage is most likely to be in use.
pub fn move_to_trash(pool: &DbPool, trash_root: &Path, path: &Path) -> Result<TrashItem, String> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "unnamed".to_string());
    let original_path = path.to_string_lossy().into_owned();

    // Metadata is read before the move, because afterwards the file is gone from
    // here and only the trash copy exists to stat.
    let size_bytes = fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0);
    let deleted_at = now_secs();

    let dir = trash_root;
    fs::create_dir_all(dir).map_err(|e| format!("Could not create trash: {e}"))?;

    // Collision-safe: if something already occupies the name, append a counter
    // rather than overwriting a previously deleted file.
    let mut target = dir.join(trash_filename(&name, deleted_at));
    let mut n = 1;
    while target.exists() {
        target = dir.join(format!(
            "{}_{}_{}",
            deleted_at,
            n,
            trash_filename(&name, deleted_at)
        ));
        n += 1;
        if n > 1000 {
            return Err("Could not find a free name in the trash".to_string());
        }
    }

    match fs::rename(path, &target) {
        Ok(()) => {}
        Err(_) => move_across_filesystems(path, &target)?,
    }

    let conn = pool.get().map_err(|_| "DB pool error".to_string())?;
    conn.execute(
        "INSERT INTO trash (original_path, trash_path, name, size_bytes, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            original_path,
            target.to_string_lossy(),
            name,
            size_bytes,
            deleted_at
        ],
    )
    .map_err(|e| format!("Could not record trashed file: {e}"))?;

    Ok(TrashItem {
        id: conn.last_insert_rowid(),
        name,
        original_path,
        size_bytes,
        deleted_at,
        days_left: RETENTION_DAYS,
    })
}

/// Copy-then-delete for the cross-filesystem case (Android SD card, network
/// shares). The copy is verified to land before the original is removed, so a
/// failure part-way through leaves the original in place rather than losing it.
fn move_across_filesystems(from: &Path, to: &Path) -> Result<(), String> {
    fs::copy(from, to).map_err(|e| format!("Could not move file to trash: {e}"))?;
    let copied = fs::metadata(to).map(|m| m.len()).unwrap_or(0);
    let original = fs::metadata(from).map(|m| m.len()).unwrap_or(0);
    if copied != original {
        let _ = fs::remove_file(to);
        return Err("Copy to trash was incomplete; the original file is untouched".to_string());
    }
    fs::remove_file(from).map_err(|e| {
        let _ = fs::remove_file(to);
        format!("Could not remove the original file: {e}")
    })
}

/// Everything currently in the trash, newest first.
pub fn list(pool: &DbPool) -> Result<Vec<TrashItem>, String> {
    let conn = pool.get().map_err(|_| "DB pool error".to_string())?;
    let now = now_secs();
    let mut stmt = conn
        .prepare(
            "SELECT id, name, original_path, size_bytes, deleted_at
             FROM trash ORDER BY deleted_at DESC, id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let deleted_at: i64 = row.get(4)?;
            Ok(TrashItem {
                id: row.get(0)?,
                name: row.get(1)?,
                original_path: row.get(2)?,
                size_bytes: row.get(3)?,
                deleted_at,
                days_left: days_left(deleted_at, now),
            })
        })
        .map_err(|e| e.to_string())?;

    let mut items = Vec::new();
    for r in rows {
        items.push(r.map_err(|e| e.to_string())?);
    }
    Ok(items)
}

fn days_left(deleted_at: i64, now: i64) -> i64 {
    let age_days = (now - deleted_at).max(0) / SECS_PER_DAY;
    (RETENTION_DAYS - age_days).max(0)
}

/// Puts a trashed file back where it came from.
///
/// A file whose original folder no longer exists, or whose original name is
/// already taken again, is restored into its original folder under a free name
/// rather than failing, because refusing would strand the file in the trash with
/// no way to reach it from the UI.
pub fn restore(pool: &DbPool, id: i64) -> Result<String, String> {
    let conn = pool.get().map_err(|_| "DB pool error".to_string())?;
    let (trash_path, original_path): (String, String) = conn
        .query_row(
            "SELECT trash_path, original_path FROM trash WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "That trash item no longer exists".to_string())?;

    let from = PathBuf::from(&trash_path);
    if !from.exists() {
        let _ = conn.execute("DELETE FROM trash WHERE id = ?1", params![id]);
        return Err("That file is no longer in the trash".to_string());
    }

    let original = PathBuf::from(&original_path);
    let parent = original
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    fs::create_dir_all(&parent)
        .map_err(|e| format!("Could not recreate {}: {e}", parent.display()))?;

    let mut to = original.clone();
    if to.exists() {
        // Something recreated this name since the delete; keep both copies.
        let stem = original
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "restored".to_string());
        let ext = original
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let dir = parent.clone();
        let mut n = 1;
        loop {
            to = dir.join(format!("{stem} (restored {n}){ext}"));
            if !to.exists() {
                break;
            }
            n += 1;
            if n > 1000 {
                return Err("Could not find a free name to restore into".to_string());
            }
        }
    }

    match fs::rename(&from, &to) {
        Ok(()) => {}
        // Trash dir and the original folder are on different filesystems when
        // the file came off an SD card.
        Err(_) => move_across_filesystems(&from, &to)?,
    }

    conn.execute("DELETE FROM trash WHERE id = ?1", params![id])
        .map_err(|e| format!("Restored, but could not update the trash list: {e}"))?;

    Ok(to.to_string_lossy().into_owned())
}

/// Permanently removes everything in the trash. Returns how many files went.
pub fn empty(pool: &DbPool) -> Result<usize, String> {
    let conn = pool.get().map_err(|_| "DB pool error".to_string())?;
    let entries = id_and_path(&conn, None)?;
    let mut removed = 0usize;
    for (_, path) in &entries {
        match fs::remove_file(path) {
            Ok(()) | Err(_) => removed += 1,
        }
    }
    conn.execute("DELETE FROM trash", [])
        .map_err(|e| format!("Could not empty the trash: {e}"))?;
    Ok(removed)
}

/// `id, trash_path` pairs, optionally only those deleted at or before a cutoff.
fn id_and_path(
    conn: &rusqlite::Connection,
    cutoff: Option<i64>,
) -> Result<Vec<(i64, String)>, String> {
    let (sql, args): (&str, Vec<i64>) = match cutoff {
        Some(c) => (
            "SELECT id, trash_path FROM trash WHERE deleted_at <= ?1",
            vec![c],
        ),
        None => ("SELECT id, trash_path FROM trash", vec![]),
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args), |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Deletes trash entries older than the retention window.
///
/// Runs at startup so the trash cannot grow without bound on a device that is
/// never given storage pressure. A row whose file is already missing is dropped
/// too, so the panel never offers a restore that would fail.
pub fn purge_expired(pool: &DbPool) -> Result<usize, String> {
    let cutoff = now_secs() - RETENTION_DAYS * SECS_PER_DAY;
    let conn = pool.get().map_err(|_| "DB pool error".to_string())?;

    let expired = id_and_path(&conn, Some(cutoff))?;
    let mut purged = 0usize;
    for (id, path) in &expired {
        // A file that cannot be removed keeps its row: something may still have
        // it open, and dropping the row would make it unreachable from the UI.
        // A file that has already gone still loses its row, so the panel never
        // offers a restore that would fail.
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(_) => continue,
        }
        conn.execute("DELETE FROM trash WHERE id = ?1", params![id])
            .map_err(|e| format!("Could not update the trash list: {e}"))?;
        purged += 1;
    }

    Ok(purged)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("vexil-trash-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn pool_at(dir: &Path) -> DbPool {
        crate::db::setup_db(&dir.to_path_buf()).unwrap();
        let manager = r2d2_sqlite::SqliteConnectionManager::file(crate::db::db_path(dir));
        r2d2::Pool::builder().max_size(1).build(manager).unwrap()
    }

    #[test]
    fn trash_filename_keeps_name_readable_and_unique() {
        let a = trash_filename("holiday photo.jpg", 1_700_000_000);
        assert!(a.ends_with("holiday photo.jpg"));
        assert!(a.starts_with("1700000000_"));

        // Two deletions in the same second must not collide.
        assert_eq!(a, trash_filename("holiday photo.jpg", 1_700_000_000));
    }

    #[test]
    fn trash_filename_sanitises_separators() {
        let name = trash_filename("a/b\\c:d.txt", 1);
        assert_eq!(name, "1_a_b_c_d.txt");
        assert!(!name.contains('/'));
        assert!(!name.contains('\\'));
    }

    #[test]
    fn blank_name_gets_a_placeholder() {
        assert_eq!(trash_filename("   ", 5), "5_unnamed");
    }

    #[test]
    fn days_left_counts_down_and_floors_at_zero() {
        let now = 100 * SECS_PER_DAY;
        assert_eq!(days_left(now, now), 30);
        assert_eq!(days_left(now - 29 * SECS_PER_DAY, now), 1);
        assert_eq!(days_left(now - 30 * SECS_PER_DAY, now), 0);
        // A clock rolled backwards must not report more than the full window.
        assert_eq!(days_left(now + 10 * SECS_PER_DAY, now), 30);
    }

    #[test]
    fn move_across_filesystems_preserves_content() {
        let root = temp_root("xdev");
        let from = root.join("source.bin");
        let to = root.join("dest.bin");
        fs::write(&from, b"the actual file contents").unwrap();

        move_across_filesystems(&from, &to).unwrap();

        assert!(!from.exists(), "original should be gone after a move");
        assert_eq!(fs::read(&to).unwrap(), b"the actual file contents");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn move_across_filesystems_keeps_original_when_copy_fails() {
        let root = temp_root("xdev-fail");
        let from = root.join("source.bin");
        let to = root.join("no-such-dir").join("dest.bin");
        fs::write(&from, b"keep me").unwrap();

        assert!(move_across_filesystems(&from, &to).is_err());
        assert!(from.exists(), "a failed copy must leave the original alone");
        assert_eq!(fs::read(&from).unwrap(), b"keep me");
        let _ = fs::remove_dir_all(&root);
    }

    /// The whole point of the feature: delete, then get the file back exactly as
    /// it was, including its contents.
    #[test]
    fn delete_then_restore_returns_the_untouched_file() {
        let root = temp_root("roundtrip");
        let pool = pool_at(&root.join("db"));
        let bin = root.join(".trash");
        let docs = root.join("Documents");
        fs::create_dir_all(&docs).unwrap();

        let original = docs.join("tax return.pdf");
        fs::write(&original, b"%PDF-1.7 important").unwrap();

        let item = move_to_trash(&pool, &bin, &original).unwrap();

        assert!(!original.exists(), "file should have left its folder");
        assert_eq!(item.name, "tax return.pdf");
        assert_eq!(item.size_bytes, b"%PDF-1.7 important".len() as i64);
        assert_eq!(item.days_left, RETENTION_DAYS);
        assert_eq!(list(&pool).unwrap().len(), 1);

        let restored_to = restore(&pool, item.id).unwrap();

        assert_eq!(restored_to, original.to_string_lossy());
        assert_eq!(fs::read(&original).unwrap(), b"%PDF-1.7 important");
        assert!(list(&pool).unwrap().is_empty(), "row should be gone");
        let _ = fs::remove_dir_all(&root);
    }

    /// Two files with the same name deleted in the same second must both survive
    /// and both restore, rather than one overwriting the other.
    #[test]
    fn same_name_deleted_twice_keeps_both_copies() {
        let root = temp_root("collide");
        let pool = pool_at(&root.join("db"));
        let bin = root.join(".trash");
        let docs = root.join("Documents");
        fs::create_dir_all(&docs).unwrap();

        let a = docs.join("notes.txt");
        let b = docs.join("sub").join("notes.txt");
        fs::create_dir_all(b.parent().unwrap()).unwrap();
        fs::write(&a, b"first").unwrap();
        fs::write(&b, b"second").unwrap();

        let first = move_to_trash(&pool, &bin, &a).unwrap();
        let second = move_to_trash(&pool, &bin, &b).unwrap();
        assert_ne!(first.id, second.id);
        assert_eq!(list(&pool).unwrap().len(), 2);

        restore(&pool, first.id).unwrap();
        restore(&pool, second.id).unwrap();

        assert_eq!(fs::read(&a).unwrap(), b"first");
        assert_eq!(fs::read(&b).unwrap(), b"second");
        let _ = fs::remove_dir_all(&root);
    }

    /// If the original name has been taken again while the file was in the
    /// trash, restore must keep both copies instead of clobbering the new file.
    #[test]
    fn restore_does_not_overwrite_a_file_created_in_the_meantime() {
        let root = temp_root("recreated");
        let pool = pool_at(&root.join("db"));
        let bin = root.join(".trash");
        let docs = root.join("Documents");
        fs::create_dir_all(&docs).unwrap();

        let original = docs.join("report.txt");
        fs::write(&original, b"the deleted one").unwrap();
        let item = move_to_trash(&pool, &bin, &original).unwrap();

        // Something else creates the same name after the delete.
        fs::write(&original, b"a different new file").unwrap();

        let restored_to = restore(&pool, item.id).unwrap();

        assert_ne!(
            restored_to,
            original.to_string_lossy(),
            "must not overwrite the newer file"
        );
        assert_eq!(fs::read(&original).unwrap(), b"a different new file");
        assert_eq!(fs::read(&restored_to).unwrap(), b"the deleted one");
        let _ = fs::remove_dir_all(&root);
    }

    /// A file whose folder was deleted while it sat in the trash should come
    /// back, with the folder recreated, rather than being unreachable.
    #[test]
    fn restore_recreates_a_vanished_parent_folder() {
        let root = temp_root("gone-folder");
        let pool = pool_at(&root.join("db"));
        let bin = root.join(".trash");
        let docs = root.join("Documents");
        fs::create_dir_all(&docs).unwrap();

        let original = docs.join("deep.txt");
        fs::write(&original, b"still here").unwrap();
        let item = move_to_trash(&pool, &bin, &original).unwrap();
        fs::remove_dir_all(&docs).unwrap();

        let restored_to = restore(&pool, item.id).unwrap();

        assert_eq!(fs::read(&restored_to).unwrap(), b"still here");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_removes_the_files_and_the_rows() {
        let root = temp_root("empty");
        let pool = pool_at(&root.join("db"));
        let bin = root.join(".trash");
        let docs = root.join("Documents");
        fs::create_dir_all(&docs).unwrap();

        for n in ["a.txt", "b.txt", "c.txt"] {
            fs::write(docs.join(n), n.as_bytes()).unwrap();
            move_to_trash(&pool, &bin, &docs.join(n)).unwrap();
        }

        assert_eq!(empty(&pool).unwrap(), 3);
        assert!(list(&pool).unwrap().is_empty());
        // Nothing left behind in the trash directory either.
        let left = fs::read_dir(&bin).unwrap().count();
        assert_eq!(left, 0, "trash directory should be empty");
        let _ = fs::remove_dir_all(&root);
    }

    /// Files older than the retention window go; newer ones stay.
    #[test]
    fn purge_only_removes_entries_past_the_retention_window() {
        let root = temp_root("purge");
        let pool = pool_at(&root.join("db"));
        let bin = root.join(".trash");
        let docs = root.join("Documents");
        fs::create_dir_all(&docs).unwrap();

        fs::write(docs.join("old.txt"), b"old").unwrap();
        fs::write(docs.join("new.txt"), b"new").unwrap();

        let old = move_to_trash(&pool, &bin, &docs.join("old.txt")).unwrap();
        let new = move_to_trash(&pool, &bin, &docs.join("new.txt")).unwrap();

        // Backdate only the first entry past the window.
        {
            let conn = pool.get().unwrap();
            let aged = now_secs() - (RETENTION_DAYS + 1) * SECS_PER_DAY;
            conn.execute(
                "UPDATE trash SET deleted_at = ?1 WHERE id = ?2",
                params![aged, old.id],
            )
            .unwrap();
        }

        assert_eq!(purge_expired(&pool).unwrap(), 1);

        let remaining = list(&pool).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, new.id, "the recent file must survive");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn restore_of_an_unknown_id_is_an_error_not_a_silent_success() {
        let root = temp_root("unknown");
        let pool = pool_at(&root.join("db"));
        assert!(restore(&pool, 9999).is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
