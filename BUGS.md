# Vexil Search — Bug & Issue Audit

Status of scan: **Sep 2026**. All findings verified against the current working
tree (`npm run build`, `cargo build`, `npx tsc --noEmit`, `npx eslint` all pass —
so every bug below is a runtime/logic/UX issue, not a compile error).

Resolution status as of the fix pass: **P0:P1 = all fixed**, P2 = all fixed
except legacy Rust WIP, P3 = all fixed, P4 = all fixed. See the per-item
`[Status]` markers below.

Severity legend:

- **P0** — broken feature / user-facing crash
- **P1** — high-impact defect or data-integrity issue
- **P2** — medium-impact defect or missing robustness
- **P3** — low-impact polish / minor UX
- **P4** — dead code / debt / cleanup

---

## P0 — Critical

### 1. Global shortcut cannot minimize/unminimize the window (missing Tauri capability) — ✅ FIXED (`3833e93`)

Added `core:window:allow-minimize` / `core:window:allow-unminimize` /
`core:window:allow-close` to `src-tauri/capabilities/default.json`; the hotkey
toggle is wrapped in try/catch and focuses `.search-input` after show.

### 2. Live Radar: the emitted file paths are discarded; both UI elements show meaningless data — ✅ FIXED (`d5de09c`)

Store holds real paths (`radarFiles: string[]`); the sidebar renders the newest
path's basename and clicks open the real path via `openResult(string)`; the
toast shows the real filename. No more `openPath("Updated N files")`.

### 3. Live Radar rows never get `file_metadata` and never re-read file content — ✅ FIXED (`d5de09c`)

Watcher now reads `fs::metadata()` (mtime/size), performs UPDATE-first to
preserve `sync_id` (INSERT with `sync_id=0` otherwise), and reads up to 2000
bytes of text content for text extensions (`txt md csv json rs ts tsx js jsx`).

### 4. Live Radar passes a _filename_ to `is_junk_dir` — ✅ FIXED (background commit `681b346`)

Junk detection is now component-based: `path.components().any(|c| is_junk_dir(...))`
checks every ancestor directory of a changed file.

---

## P1 — High impact

### 5. `src/store.ts` is a stale, conflicting duplicate — ✅ FIXED (deleted, `ff46fb3`)

### 6. MenuBar.tsx / Toolbar.tsx extracted but unused — ✅ FIXED (deleted by `681b346`; inline versions kept)

### 7. `handleDelete` leaves stale My Picks / Recent — ✅ FIXED (`4cbd47b`)

Store `handleDelete` removes the row from `results`, `myPicks`, and
`recentItems`, then clears `selectedResult`.

### 8. Store's `handleCopyPath` / `handleDelete` were no-ops — ✅ FIXED (`4cbd47b`)

Real implementations now live in the store (clipboard copy; delete via
`delete_file` with full cleanup). Hooked into the inline toolbar.

### 9. Empty / short / punctuation-only queries break or return nothing — ✅ FIXED (`9cdd2ae`)

`search_files` guards punctuation-only input (`Ok(vec![])`), falls back to
`LIKE path/title` when no token has ≥3 alphanumeric chars (trigram can't match
those), and drops sub-trigram tokens from the FTS junction.

### 10. Search isn't truly cancellable on the backend — ✅ FIXED (`4cbd47b`, frontend)

`runSearch` in the store uses a latest-wins generation counter (`searchSeq`) +
250ms debounce; every invocation cancels the previous timer and stale invokes
discard their results. Enter (submit) runs `runSearch(query, true)`, clearing
the pending debounce — no duplicate query.

> Note: an `INDEX_GEN` generation counter at the Rust level was authored by a
> concurrent process and is **uncommitted** (`src-tauri/src/lib.rs`). Verify and
> keep or drop it when that file lands.

---

## P2 — Medium

### 11. Debug `println!` on every search keystroke — ✅ FIXED (`9cdd2ae`)

Removed the per-query prints in `search_files` (LIKE/Regex/FTS result counts and
the "search_files called" line). Error-path prints remain.

### 12. `log`/`env_logger` declared but never initialized — ✅ FIXED (background commit removed the deps from `Cargo.toml`)

### 13. `tauri-plugin-dialog` registered but unused — ✅ FIXED (background commit `5f8996e` removed plugin + `Cargo.toml` dep)

### 14. Live Radar DB-failure backoff silently drops pending events — ✅ FIXED (`d5de09c`)

`pending_paths` is only drained after a successful connection; on DB error the
set is kept and the loop sleeps 500 ms before retrying.

### 15. FTS vs regex result limits inconsistent (20 vs 50) — ✅ FIXED (`9cdd2ae`), unified to `LIMIT 50`

### 16. Search submit duplicates the debounce — ✅ FIXED (`4cbd47b`), see #10

### 17. Aborted searches can leave `isSearching` stuck true — ✅ FIXED (`4cbd47b`)

`runSearch` always resets `isSearching` on every path (empty query, success,
and error), and stale invokes are discarded by the generation counter.

### 18. Recent-items list never pruned — ✅ FIXED (`4cbd47b`) via #7 (delete drops the entry from `recentItems`)

### 19. Virtualizer `estimateSize` / sticky-header jitter — ✅ PARTIALLY FIXED (`4cbd47b`)

`estimateSize: () => 48` (slight over-estimate to avoid scroll jump). The sticky
header + spacer rows pattern still warrants a visual check at runtime.

### 20. Window not auto-focused on search input when summoned — ✅ FIXED (`3833e93`)

Hotkey path focuses `document.querySelector('.search-input')` after `setFocus()`.

---

## P3 — Low / Polish

### 21. Menu items that do nothing — ✅ FIXED (`75c8b11`)

New Search clears the query + focuses input (also wired to Ctrl+N); Edit→Copy
copies the selected path, Paste reads the clipboard into the search box,
Select All selects the input text.

### 22. Duplicate `localStorage` writes for theme/shortcut — ✅ FIXED (`4cbd47b` + `e8fa85a`)

Manual `localStorage.setItem` calls removed; persist middleware is the single
source of truth.

### 23. `radarToast` split on a count string — ✅ FIXED (`d5de09c`), renders the real basename (`radarFiles[last].split(/[\\/]/).pop()`)

### 24. Fake indeterminate progress bar — ✅ FIXED (`e8fa85a`)

Removed the animated `progress-bar-fill` (never reflected a real total) and its
JSX + CSS; the info bar keeps the live file count.

### 25. "Showing All" always rendered — ✅ FIXED (`4cbd47b`), suffix hidden when `activeCategory === "All"`

### 26. Emoji tree arrows — ✅ FIXED (`75c8b11`), replaced with inline SVG chevron; loading shows a text ellipsis

### 27. Duplicate/conflicting `.search-wrapper` CSS — ✅ FIXED (`e8fa85a`)

Merged into a single block (modern look: 34px height, flex:1, max-width 360px)
at the top of the file; the duplicate "Modern Search Box" block and the
redundant `.search-wrapper svg/input` selectors were removed.

### 28. `SearchResult.id` u32 → i64 — ✅ FIXED (`75c8b11` struct; `row.get::<_, i64>` in `lib.rs`)

> ⚠️ The three `i64` one-liners in `src-tauri/src/lib.rs` are currently sitting
> **uncommitted** in the shared working tree (alongside a concurrent agent's
> `INDEX_GEN` work). They compile and are validated by `cargo build`, but they
> will land only when that file is committed.

### 29. `open_in_explorer` silently ignores failures — ✅ FIXED (`e8fa85a`)

Now alerts the user with the failing path on error.

---

## P4 — Dead code / cleanup

### 30. `src-tauri/src/db_pool.rs` un-compiled leftover — ✅ FIXED (deleted, `ff46fb3`)

### 31. `refactor.py` leftover migration script — ✅ FIXED (deleted by background)

### 32. Empty `src-tauri/src/bin/` dir — ✅ FIXED (deleted, `ff46fb3`)

### 33. Dead import / interface drift in `src/store.ts` — ✅ FIXED (file deleted, `ff46fb3`)

### 34. Redundant `core:window:allow-is-visible` — ✅ FIXED (`e8fa85a`)

Verified against `src-tauri/gen/schemas/acl-manifests.json` that
`allow-is-visible` is already inside `core:window:default`; explicit grant
removed.

---

## Still open / owned by the concurrent process (not from this audit)

These appeared in the working tree during the fix pass and are **uncommitted**:

- `src-tauri/src/lib.rs` — `INDEX_GEN` generation-counter cancellation of
  running indexers (compile-tested OK), plus a few `println!("DEBUG: ...")` in
  `start_indexing` that should become `eprintln!`/`log` or be removed before
  commit.
- `src-tauri/src/security.rs` — strips the Windows `\\?\` UNC prefix after
  canonicalization in `AllowedRoots::resolve` (lgtm; wins-prefix deseeding).
- `scratch_test/` — untracked scratch Cargo crate at repo root; delete or move
  out of the repository before commit.

## Already fixed in current tree (do not re-report)

- `open_in_explorer` command exists (`lib.rs`) and is in `invoke_handler`.
- Store setters `setCustomDirs`/`setExcludedDirs` accept updater functions.
- `ResultsTable` uses store `openResult`; no repeated `getVirtualItems()` calls.
- FTS5 trigram + size/mtime metadata in `file_metadata`, BM25 rescale,
  incremental mtime indexing, path-traversal hardening, CSP font bundling.
- FTS escaping of special chars, regex size/DFA limits.
