# Vexil Search — Bug & Issue Audit

Status of scan: **Sep 2026**. All findings verified against the current working
tree (`npm run build`, `cargo build`, `npx eslint` all pass — so every bug below
is a runtime/logic/UX issue, not a compile error).

Severity legend:

- **P0** — broken feature / user-facing crash
- **P1** — high-impact defect or data-integrity issue
- **P2** — medium-impact defect or missing robustness
- **P3** — low-impact polish / minor UX
- **P4** — dead code / debt / cleanup

---

## P0 — Critical

### 1. Global shortcut cannot minimize/unminimize the window (missing Tauri capability)

- **Files:** `src-tauri/capabilities/default.json`, `src/App.tsx:141-153`
- **Problem:** The hotkey handler calls `appWindow.minimize()`,
  `appWindow.unminimize()`, `show()`, `setFocus()`, `isVisible()`,
  `isMinimized()`. The capability file explicitly grants
  `allow-show`, `allow-set-focus`, `allow-is-visible` (and
  `allow-is-minimized` is in `core:window:default`), but **not**
  `core:window:allow-minimize` or `core:window:allow-unminimize`.
  In Tauri 2 those two mutating commands are NOT in `core:window:default`
  (verified against generated `acl-manifests.json`). Pressing the hotkey while
  the window is visible/minimized will reject with a permission error and an
  unhandled promise rejection.
- **Suggested fix:** Add to `default.json` permissions:
  `"core:window:allow-minimize"`, `"core:window:allow-unminimize"`.
  Optionally wrap the calls in try/catch and log.

### 2. Live Radar: the emitted file paths are discarded; both UI elements show meaningless data

- **Files:** `src-tauri/src/lib.rs:505-526`, `src/App.tsx:100-103`, `src/App.tsx:698-727`, `src/App.tsx:981-999`
- **Problem:** The backend collects real paths in `processed_paths` and emits
  `live-radar-batch`, but the frontend replaces them with a summary string
  (`event.payload.length` only):
  ```ts
  setRadarToast(`Updated ${event.payload.length} files`);
  ```
  The sidebar entry then calls `openResult(radarToast)`, i.e.
  `openPath("Updated 3 files")` — opening a nonexistent path. The toast's
  "filename" line also renders the same count string instead of a filename.
- **Suggested fix:** Store the last real path (e.g. keep the batch payload in
  store as `radarPaths: string[] | null` + the count). Render
  `radarPaths[0]` as a clickable entry and `openResult(radarPaths[0])`.
  Keep the toast for bulk counts but show the actual newest filename.

### 3. Live Radar rows never get `file_metadata` (no size/mtime) and never re-read file content

- **File:** `src-tauri/src/lib.rs:517-518`
- **Problem:** The watcher only inserts into `file_index`:
  ```rust
  let _ = conn.execute("INSERT INTO file_index (title, path, content) VALUES ...");
  ```
  It never inserts/updates `file_metadata`, so radar-detected files have
  `size = 0` and `modified = 0`. Consequences:
  - Size filters treat them as "Small (<1MB)" and exclude them from "Large".
  - Date filters (`Today`/`This Week`/`This Month`) all exclude them because
    `new Date(0)` = 1970.
  - `content` is only `"title path"` — no snippet from file body, so FTS
    relevance/snippet quality drops vs. full indexing.
    Additionally the incremental indexer (`start_indexing`) computes mtime/size
    from `entry.metadata()` — do the same here.
- **Suggested fix:** In the watcher, call `std::fs::metadata()`, insert
  `INSERT OR REPLACE INTO file_metadata (path, mtime, size) VALUES (?1,?2,?3)`,
  and read up to 2000 chars of text content for text extensions (match the
  extension list in `start_indexing`).

### 4. Live Radar passes a _filename_ to `is_junk_dir` (directory-name filter)

- **File:** `src-tauri/src/lib.rs:512`
- **Problem:** `is_junk_dir` checks known directory names
  (`node_modules`, `.git`, `target`, ...). The watcher calls it with
  `title_str`, the _file name_. A file literally named `node_modules`
  (no extension) would be skipped, while files inside junk dirs would not be
  skipped anyway (the watcher doesn't prune by directory).
- **Suggested fix:** Before handling a path, check `path.parent()` file names
  against `is_junk_dir`, or simply drop the per-file check and rely on a
  parent-path check.

---

## P1 — High impact

### 5. `src/store.ts` is a stale, conflicting duplicate of the store

- **File:** `src/store.ts` (entire file, 139 lines)
- **Problem:** A full previous version of the Zustand store with an
  incompatible `SearchResult` (no `size`/`modified`), legacy
  `filteredResults`, and a `applyFilters` that documents the size filter as a
  TODO. It is compiled by `tsc` (in `include: ["src"]`) but imported nowhere.
  It is a maintenance/type-drift hazard and dead weight.
- **Suggested fix:** Delete `src/store.ts`. Confirm nothing imports it
  (verified: nothing does).

### 6. MenuBar.tsx and Toolbar.tsx were extracted but are never used

- **Files:** `src/components/MenuBar.tsx`, `src/components/Toolbar.tsx`
- **Problem:** The refactor extracted these components, but `App.tsx` still
  renders a duplicate inline menu bar (`App.tsx:350-472`) and toolbar
  (`App.tsx:475-650`). The extracted components are dead code, and the two
  copies will drift (they already differ: MenuBar `onMouseLeave` sets `""` in
  the component vs `null` in App; Exit uses `window.close()` vs
  `getCurrentWindow().close()`).
- **Suggested fix:** Wire the extracted components into `App.tsx`, or delete
  them. Prefer wiring them in and removing the inline JSX.
  Note: `Toolbar.tsx`'s `handleSearch` currently does nothing and its
  `handleDelete`/`handleCopyPath` come from the store where they are **no-ops**
  (see #8) — fix those before wiring.

### 7. `handleDelete` leaves stale entries in My Picks / Recent

- **File:** `src/App.tsx:253-261`
- **Problem:** After `delete_file` succeeds, the row is filtered from
  `results`, but matching entries remain in `myPicks` and `recentItems`.
  Clicking a deleted file's pick later fails silently (or crashes on `titles`
  display with a dead path).
- **Suggested fix:** After successful deletion also
  `removeMyPick(id)` and drop the item from `recentItems` (add a store action
  like `removeRecentItem` or recompute in `handleDelete`).

### 8. Store's `handleCopyPath`, `handleDelete` are no-ops

- **File:** `src/store/searchStore.ts:144-145`
- **Problem:** The Toolbar's buttons (and any wiring) call these actions; they
  simply `set({})` — copy and delete do nothing.
- **Suggested fix:** Move the real implementations into the store:
  - `handleCopyPath: () => { const s = get().selectedResult; if (s && navigator.clipboard) navigator.clipboard.writeText(s.path); }`
  - `handleDelete: async () => { const s = get().selectedResult; if (!s) return; await invoke("delete_file", { path: s.path }); set(state => ({ results: state.results.filter(r => r.id !== s.id), myPicks: state.myPicks.filter(p => p.id !== s.id), recentItems: state.recentItems.filter(r => r.id !== s.id) })); }`

### 9. Empty/single-char/only-punctuation queries break or return nothing

- **Files:** `src-tauri/src/lib.rs:296-306`, `src/App.tsx:227-230`
- **Problem:**
  - The trigram tokenizer cannot match 1–2 char queries → short queries always
    return zero results even if a file matches.
  - A query made only of punctuation (`+++`, `---`) becomes `""` (empty quoted
    phrase) after escaping, which FTS5 treats as a syntax error → `search_files`
    returns `Err`, and the frontend only logs it, showing nothing.
- **Suggested fix:** In `search_files`, if the cleaned terms produce an empty
  query, return `Ok(vec![])` early. For short (<3 chars) queries consider a
  LIKE fallback on `path/title` (e.g. `WHERE path LIKE ? OR title LIKE ?`)
  since trigram can't match them.

### 10. Search isn't truly cancellable on the backend

- **Files:** `src/App.tsx:200-208`, `src-tauri/src/lib.rs:234`
- **Problem:** The frontend `AbortController` only prevents _state_ from being
  applied — the Rust query still runs to completion on every keystroke
  (debounced 250ms). Fast typers spawn many concurrent `search_files` IPC calls
  that all hit the DB.
- **Suggested fix:** Debounce harder (e.g. 300–400ms) and/or deduplicate
  server-side with a "latest query wins" generation counter (store the last
  query string in `AtomicUsize`-guarded state, discard results that are no
  longer the latest). Full IPC cancellation is not available in Tauri 2.

---

## P2 — Medium

### 11. Debug `println!` on every search keystroke

- **File:** `src-tauri/src/lib.rs:244, 280, 327-328, 338`
- **Problem:** `search_files` logs 3–5 lines per query into the terminal
  (including every debounced keystroke). Noise and slight perf cost; nothing is
  gaining observability except ad-hoc prints.
- **Suggested fix:** Remove the `println!`s or gate behind `log::debug!` and
  initialize `env_logger`.

### 12. `log`/`env_logger` dependencies are declared but never initialized

- **File:** `src-tauri/Cargo.toml:32-33`
- **Problem:** `env_logger::init()` is never called; no logging happens.
  Dead deps.
- **Suggested fix:** Either call `env_logger::init()` early in `lib.rs::run()`
  and use `log`, or remove the deps.

### 13. `tauri-plugin-dialog` is registered but never used and has no capability

- **Files:** `src-tauri/Cargo.toml:31`, `src-tauri/src/lib.rs:428`, `src-tauri/capabilities/default.json`
- **Problem:** `tauri_plugin_dialog::init()` is registered, but no frontend code
  uses it and `default.json` grants no `dialog:*` permission (so it would be
  blocked anyway). Unused plugin + unused capability surface.
- **Suggested fix:** Remove the plugin from `Cargo.toml` and `.plugin(...)`
  (or add capability permissions if a file-picker is planned).

### 14. Live Radar DB-failure backoff silently DROPS all pending events

- **File:** `src-tauri/src/lib.rs:527-530`
- **Problem:** On DB error the watcher clears `pending_paths`
  (`pending_paths.clear()`), permanently losing changes. Also, after a sleep
  it re-enters `rx.recv_timeout`, so it can miss events buffered in the
  channel between the error and the clear — the item is dropped before
  re-reading the channel.
- **Suggested fix:** Keep pending paths on failure; move only successfully
  processed paths out. If the DB fails repeatedly, back off without dropping
  the set (or limit the retained set size).

### 15. FTS vs regex result limits are inconsistent (20 vs 50)

- **File:** `src-tauri/src/lib.rs:248-256` vs `:283-291`
- **Problem:** Regex search caps at `LIMIT 50`, FTS at `LIMIT 20`. Users get
  different result counts depending on query form.
- **Suggested fix:** Choose one canonical limit (e.g. 50) and use it in both.

### 16. Search submit (Enter) triggers an immediate query that duplicates the debounce

- **File:** `src/App.tsx:227-230` and `:200-208`
- **Problem:** Typing and pressing Enter runs `runSearch` immediately _and_
  250ms later the debounced effect runs again → double query.
- **Suggested fix:** On submit, cancel the pending debounce (via the abort
  controller) and let the query run once, or remove the immediate call and
  rely on the debounce.

### 17. Aborted searches can leave `isSearching` stuck true

- **File:** `src/App.tsx:191-193`
- **Problem:** When a request is aborted, `setIsSearching(false)` is skipped
  (`if (!signal?.aborted)`). If the component unmounts or a query is cleared
  (`query.trim() === ""` → early return without resetting `isSearching`),
  the spinner can stay visible. Also clearing the search box
  (`setResults([])` on empty query) never resets `isSearching` set earlier.
- **Suggested fix:** Always `setIsSearching(false)` in `finally` regardless of
  abort; abort ordering protects against stale results via `signal` checks.

### 18. Recent-items list is never pruned after a file disappears

- **File:** `src/store/searchStore.ts:106-112`
- **Problem:** `recentItems` keeps paths that may be deleted/moved; clicking
  them just fails. No dedup against current results or removal on delete.
- **Suggested fix:** Integrate with #7 (remove on delete). Optionally verify
  existence on open and drop the item if missing.

### 19. `.results-container` has `height:100%` with `overflow:auto` — virtualizer and sticky header may scroll together

- **File:** `src/components/ResultsTable.tsx:25-30`, `src/App.css:372-385`
- **Problem:** The `<table>` uses a sticky `<thead>` _inside_ the same scroll
  container that the virtualizer tracks. With spacer `<td>` rows used for
  virtualization and a sticky header, header alignment/virtual offset can
  glitch when scrolling (common TanStack Virtual + table pattern). Also
  `estimateSize: () => 40` may under-estimate row height (8px td padding top
  - bottom, ellipsized multi-line), causing scroll jumpiness.
- **Suggested fix:** Verify visually; if jittery, set a fixed `min-height` on
  rows and keep `estimateSize` in sync (e.g. 32px + 16px padding = 48px), or
  switch to a CSS-grid/div-based virtualized list (no `<table>`).

### 20. Window is never auto-focused on its input when summoned via hotkey

- **File:** `src/App.tsx:141-153`
- **Problem:** The hotkey shows/focuses the window but the search input is not
  focused, so the user must click before typing (defeats "summon" UX).
  `searchInputRef` exists but is unused.
- **Suggested fix:** After `setFocus()`, call
  `document.querySelector<HTMLInputElement>('.search-input')?.focus()` (or
  expose a store/ref from App and focus it).

---

## P3 — Low / Polish

### 21. Menu items that do nothing

- **File:** `src/App.tsx:364-401`
- **Problem:** "New Search" (Ctrl+N), "Copy/Paste/Select All" have no behavior.
  Purely decorative.
- **Suggested fix:** Implement or label them as disabled/coming-soon.

### 22. Duplicate `localStorage` writes for theme/shortcut

- **Files:** `src/App.tsx:76, 157`, `src/store/searchStore.ts:147-156`
- **Problem:** App writes `vexil-theme` and `vexil-shortcut` directly while the
  persist middleware also persists them under `vexil-storage`. Two sources of
  truth; rehydration can differ if one is tampered.
- **Suggested fix:** Rely only on the persist middleware; drop the manual
  `localStorage.setItem` calls in App.

### 23. `radarToast` uses `split("\\")` on a count string

- **File:** `src/App.tsx:718`
- **Problem:** `radarToast.split("\\").pop()` implies a Windows path, but the
  value is `"Updated N files"`. Dead logic and confusing.
- **Suggested fix:** Simplifies to showing the real filename (`radarPaths[0]`),
  see #2.

### 24. Indexing progress bar is a fake indeterminate animation

- **File:** `src/App.css:331-361`
- **Problem:** `progress-bar-fill` is a CSS keyframe that animates width
  30%→50% forever; it does not reflect `indexingProgress`. The info bar shows
  the real count but the bar never reaches 100%.
- **Suggested fix:** Either make the bar width proportional to a total
  (needs total-file estimate from backend) or remove it.

### 25. "Showing {activeCategory}" is always rendered, even for "All"

- **File:** `src/App.tsx:654`
- **Problem:** Info bar reads oddly: "25 items found. Showing All".
- **Suggested fix:** Hide the suffix when `activeCategory === "All"`.

### 26. `emojis` used for tree arrows (⏳ ▼ ▶)

- **File:** `src/components/TreeNode.tsx:91`
- **Problem:** Emoji glyphs vary across systems/fonts (and on some Windows
  builds render as colored emoji, inconsistent with the app's flat style).
- **Suggested fix:** Replace with inline SVG or CSS triangles.

### 27. Duplicate/conflicting `.search-wrapper` CSS definitions

- **File:** `src/App.css:54-76` and `:262-309`
- **Problem:** Two `.search-wrapper` blocks with conflicting rules (the second
  overrides `padding`, `max-width`, `height`, `flex`). Message: keep one.
  This is why the toolbar previously had a squished search box.
- **Suggested fix:** Merge into one block; delete the other.

### 28. `SearchResult.id` typed `u32` on backend but `number` on frontend; rowid overflow

- **Files:** `src-tauri/src/db.rs:6-14`, `src-tauri/src/lib.rs:266, 316`
- **Problem:** `rowid` is read as `u32`. For very large indexes (>4.29B rows)
  this errors; also inconsistent with React's `number`. Low probability but
  trivially fixed.
- **Suggested fix:** Use `i64` for `id` in `SearchResult` (Rust) and match the
  TS interface (`id: number` stays fine, but series on `row.get::<_, i64>`).

### 29. `open_in_explorer` silently ignores failures

- **File:** `src/store/searchStore.ts:140-143`
- **Problem:** `invoke("open_in_explorer", ...).catch(console.error)` — no user
  feedback when a path no longer exists.
- **Suggested fix:** Surface a toast/alert on failure.

---

## P4 — Dead code / cleanup

### 30. `src-tauri/src/db_pool.rs` is an un-compiled leftover (round-robin logic is broken and `tokio` is missing)

- **File:** `src-tauri/src/db_pool.rs` (entire file)
- **Problem:** No `mod db_pool;` declaration exists anywhere, so it never
  compiles (build passes only because it's excluded). Its `acquire()` round-robin:
  ```rust
  let idx = permit.clone().forget().into_iter().count() % self.connections.len();
  ```
  is nonsensical (counts permit-forsaken semaphore permits, not connection
  index), and it imports `tokio` which is **not** in `Cargo.toml` — it would
  fail to compile if ever referenced.
- **Suggested fix:** Delete the file.

### 31. `refactor.py` is a leftover one-shot migration script

- **File:** `refactor.py`
- **Problem:** Untracked helper from the store extraction; references exact old
  `App.tsx` state it already replaced. Dead tooling.
- **Suggested fix:** Delete (or move to a `scripts/` dir with a doc).

### 32. `src-tauri/src/bin/` is an empty untracked directory

- **File:** `src-tauri/src/bin/` (empty)
- **Problem:** Leftover empty dir polluting `git status`; cargo sees a `bin`
  folder with no `main.rs` — harmless but pointless.
- **Suggested fix:** Delete the directory (or add to `.gitignore`).

### 33. Dead import / unused interface drift in `src/store.ts`

- **File:** `src/store.ts`
- **Problem:** See #5. The stale `Category` union (with `Documents`/`Images`)
  and `SearchResult` interface contradict the live store (`searchStore.ts`).
- **Suggested fix:** Delete `src/store.ts`.

### 34. `core:window:allow-is-visible` is redundant (it's already in `core:window:default`)

- **File:** `src-tauri/capabilities/default.json:12`
- **Problem:** Redundant grant; harmless but noisy.
- **Suggested fix:** Remove after adding `allow-minimize`/`allow-unminimize`.

---

## Already fixed in current tree (do not re-report)

These were flagged in earlier audits and are resolved in the working copy:

- `open_in_explorer` command exists (`src-tauri/src/lib.rs:419-423`) and is in
  `invoke_handler`.
- Store setters `setCustomDirs`/`setExcludedDirs` accept updater functions
  (`src/store/searchStore.ts:114-121`).
- `ResultsTable` uses store `openResult`, no repeated `getVirtualItems()`
  calls.
- FTS5 trigram + size/mtime metadata in `file_metadata`, BM25 rescale,
  incremental mtime indexing, path-traversal hardening, CSP font bundling.
- FTS escaping of special chars, regex size/DFA limits.
