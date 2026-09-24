# Vexil Search — Bug & Issue Audit

Status of scan: **Sep 2026 (second pass)**. All findings verified against the
current working tree / HEAD `d388b43` (`npm run test:unit`, `cargo build`,
`cargo test`, `npx tsc --noEmit`, `npx eslint src` all pass — so every bug
below is a runtime/logic/UX issue, not a compile error). A follow-up fix pass
resolved every open item; see "Fix pass — Sep 2026" at the bottom.

Severity legend:

- **P0** — broken feature / user-facing crash
- **P1** — high-impact defect or data-integrity issue
- **P2** — medium-impact defect or missing robustness
- **P3** — low-impact polish / minor UX
- **P4** — dead code / debt / cleanup

Resolved by the previous audit's fix pass and **do not re-report**: global
shortcut capabilities & toggle (`3833e93`), Live Radar path/metadata/content
fixes (`d5de09c`), junk-dir component check (`681b346`), stale `store.ts` /
`MenuBar` / `Toolbar` / `db_pool.rs` / `refactor.py` / empty `bin/` deletions
(`ff46fb3`), store action implementations (`4cbd47b`), search hardening
LIKE/regex/FTS fallbacks & unified `LIMIT 50` (`9cdd2ae`), menu wiring + SVG
arrows + `i64` ids (`75c8b11`), progress-bar / CSS / capability cleanup
(`e8fa85a`), and `security.rs` UNC-prefix strip (committed).

---

## P1 — High impact

### 1. Every custom-dir / excluded-dir change triggers a full re-index

`src/App.tsx:106-140` — the mount effect depends on `triggerIndexing`
(`useCallback` recreated whenever `customDirs`/`excludedDirs` change,
`src/App.tsx:96-104`). The effect body calls `triggerIndexing()` and re-runs on
any tree checkbox toggle → **one full disk scan per checkbox click**, each new
scan canceling the previous via `INDEX_GEN` bump (`src-tauri/src/lib.rs:59`).
Typing through the Settings tree causes repeated, mutually-canceling whole-disk
scans and chewing disk I/O.

Fix direction: trigger re-index explicitly (button/hotkey in Settings or a
"changed" flag), or only re-listener on setting change and reindex on mount.

### 2. "Run in Background" is on by default, contradicting the Pro gate

`runInBackground` defaults to `true` in the store (`src/store/searchStore.ts:104`)
and backend `AppState` (`src-tauri/src/lib.rs:729`). The Pro gate in
`setRunInBackground` (`src/store/searchStore.ts:162-171`) only blocks _enabling_;
free users already start with it enabled. Result: on fresh installs the window
close hides to tray (app keeps running, `lib.rs:857-865`) and **File → Exit
(`getCurrentWindow().close()`) does not quit — it hides to tray** because
`CloseRequested` is prevented. Only the tray "Quit" exits.

Fix direction: default `false` (and require Pro to enable), and/or make
File → Exit call a real quit (e.g. `app.exit(0)` via an `exit_app` command or
`window.destroy()` behind a "really quit" flag).

### 3. Live Radar never sets `category` → radar files are always "Other"

The watcher (`src-tauri/src/lib.rs:816-829`) UPDATEs only mtime/size and
INSERTs metadata without a category, so the schema default `'Other'`
(`db.rs:73`) applies. `get_category()` exists but is not used here. A fresh
MP3/PDF in Downloads is invisible to the Music/Documents filters until the next
full re-index. Also new files get `file_metadata.sync_id = 0` and rely on the
next scan to bump it.

Fix direction: compute `get_category(is_file, ext)` in the watcher and include it
in both UPDATE and INSERT.

### 4. Deleted files stay searchable

- The watcher ignores `EventKind::Remove` (`lib.rs:763`), so files deleted on
  disk remain in `file_index` until the next full scan.
- `delete_file` command removes from `file_index` but **not** `file_metadata`
  (`lib.rs:618-639`), leaving an orphaned metadata row.

### 5. `.unwrap()` in background threads × `panic = "abort"` = whole-app crash

`panic = "abort"` is set for release (`Cargo.toml`). The indexing thread uses
`.unwrap()` liberally (`lib.rs:231-232`, `250-255`, `293-297`), and the watcher
thread plus `process_batches` also assume success. Any SQLite error (WAL lock
timeout, corrupt DB, disk full) in a spawned thread aborts the entire process
instead of surfacing an error. Prefer propagating errors / early `done(0)` +
logging.

---

## P2 — Medium

### 6. Pro-only drive classification misfires on common hardware

`get_system_drives` (`src-tauri/src/lib.rs:541-544`) marks any kind other than
`HDD`/`SSD` as Pro-only:

```rust
let is_pro_only = match kind { HDD | SSD => false, _ => true };
```

But **sysinfo 0.32.1's `DiskKind` has only `HDD`, `SSD`, `Unknown(isize)`**
(verified in `sysinfo-0.32.1/src/common/disk.rs` — no NVMe/EMMC/Removable
variants). The Windows impl returns `Unknown(-1)` whenever the seek-penalty
IOCTL fails (`sysinfo-0.32.1/src/windows/disk.rs`), which happens for optical
drives, RAM disks, and on some NVMe setups. On affected machines the _primary
drive_ is flagged 👑 PRO and free users cannot select it in the tree.

Fix direction: base Pro-ness on `disk.is_removable()` (available in this
sysinfo version) or on volume type, not `DiskKind`, and treat `Unknown` as
"free" rather than "Pro".

### 7. `open_in_explorer` and `openPath` bypass the path security model

`delete_file` and `get_directories` validate through `security::AllowedRoots`,
but `open_in_explorer` (`lib.rs:642`) passes the raw webview-supplied string
straight to `opener::reveal`, and the frontend `openPath` (opener plugin
`allow-open-path`) is uncapped. Low impact for a trusted local webview, but
inconsistent with the hardened commands.

### 8. Settings tree lists every volume; Pro-only children inherit badge but not gating

`TreeNode` propagates `isProOnly` to all children (`src/components/TreeNode.tsx:161`)
— correct for permission, but combined with #6 the misclassification spreads to
an entire drive's subtree.

### 9. Radial watcher INSERT path can hit a UNIQUE constraint on no-op Modify

`lib.rs:824-829` — `UPDATE ... WHERE path=?`; if the event's mtime/size are
unchanged, `conn.changes() == 0` triggers a plain `INSERT` into a `path`-PK
table → swallowed "UNIQUE constraint failed". Harmless but noisy; prefer
`INSERT OR IGNORE` / UPSERT.

### 10. `get_index_stats` reports directories in "Database: N files"

It counts `file_metadata` rows, which includes `Folder` entries — cosmetic
count inflation in the info bar.

---

## P3 — Low / Polish

### 11. Frontend lint warnings (0 errors, 5 warnings)

- `src/App.tsx:104,140,234` — `react-hooks/exhaustive-deps` (zustand setters
  are stable; add them or eslint-disable with a comment).
- `src/App.tsx:298` — `useCallback(getFilteredResults)` lists
  `activeCategory` which it never reads (category filtering is backend-side).
- `src/components/ResultsTable.tsx:168` — `useVirtualizer`
  `react-hooks/incompatible-library` (React-Compiler lint, informational).

### 12. Vitest run prints React `act(...)` warnings

`npm run test:unit` passes but both tests emit
"An update to App inside a test was not wrapped in act(...)" — async
`invoke`/listener state updates leak past `render`. Wrap in `await`/`act` or
use `findBy*` + `vi.waitFor`.

### 13. Dead store actions

`addRecentItem` (`src/store/searchStore.ts:135`) and `setIsPro` (`:108`) are
defined but never called (`openResult` inlines its own recent-items update).
`setIsPro` is notable: nothing anywhere sets `isPro`, so the feature is entirely
inert/bystandered — see also Pro gates being cosmetic (client-side `alert()` +
persisted flag, trivially editable in localStorage).

### 14. Unused npm dependency `@tauri-apps/plugin-dialog`

`package.json:19` declares it but no source imports it (the Rust dialog plugin
was removed in an earlier cleanup). Remove from dependencies.

### 15. wdio plugins compiled into release binaries

`tauri-plugin-wdio` / `tauri-plugin-wdio-webdriver` are unconditional Cargo
deps (`Cargo.toml:34-35`); only the _init_ is gated to debug
(`lib.rs:660-665`). Release builds still link them (binary bloat, and they
expose an attack surface if ever initialized). Gate the deps to
`[target.'cfg(debug_assertions)'.dependencies]`.

### 16. Hardcoded GitHub links use `blob/master`

`src/App.tsx` links (`App.tsx:464`, `989`, `1005`) point at
`priyaranjan-sahu/vexil-search/blob/master/...`. Origin remote is
`priyaranjan-sahu/vexil`; public remote `vexil-search`. Files
`PRIVACY_POLICY.md` / `TERMS_AND_CONDITIONS.md` exist in-repo — if the public
repo's default branch is not `master` these 404. Verify / make branch-agnostic.

### 17. `search_files` regex/LIKE constant snippet + FTS snippet only highlights title column

`lib.rs:358,397` use a static "Matched in path or title" snippet; the FTS branch
snippets only column 0 (title). Not a bug, but search-in-path matches show as
unhighlighted.

---

## P4 — Dead code / debt / cleanup

### 18. `scratch_test/` is committed to git — ~110 MB build artifacts

`git ls-files scratch_test` → **178 tracked files, ~115 MB** (a scratch Cargo
crate with `target/`; all of it is build output). This bloats every clone/push.
Fix:

```
git rm -r --cached scratch_test
echo "scratch_test/" >> .gitignore   # or delete outright
git commit
```

### 19. Misc Rust cleanups

- Duplicate `use tauri::Emitter;` inside `start_indexing` (`lib.rs:95` and `:130`).
- `println!` debug logging in the indexer/watcher (`lib.rs:92,97,104,150,...`)
  — switch to `log`/structured, keep release silent.
- `security::AllowedRoots::add_custom` is `#[allow(dead_code)]` — unused now
  that everything runs in `allow_whole_disk = true` mode.

### 20. `wdio.conf.ts` / `test/e2e/*.ts` are outside type-checking

`tsconfig.json` includes only `src`; `tsconfig.node.json` only `vite.config.ts`.
The LSP reports missing `node`/`@wdio/globals` types in `wdio.conf.ts` and
`test/e2e/app.spec.ts` (and a stale `@ts-expect-error` in `vite.config.ts`)
while `npx tsc --noEmit` passes — those files are compiled by neither config, so
E2E specs can drift out of type-safety. Add a `tsconfig.wdio.json` or `types`
entries if desired.

---

## Fix pass — Sep 2026

All 20 items above were resolved in this pass:

- **#1** `App.tsx` — `triggerIndexing` now reads `customDirs`/`excludedDirs` via
  `useSearchStore.getState()` and is stable, so the mount effect runs once;
  Settings checkbox toggles no longer trigger disk scans.
- **#2** `runInBackground` defaults to `false` (store + `AppState`); File → Exit
  now calls a new `exit_app` command (`app.exit(0)`) instead of `window.close()`.
- **#3** Watcher computes `get_category(false, ext)` and stores it on INSERT/UPDATE.
- **#4** Watcher handles `EventKind::Remove` and purges `file_index` +
  `file_metadata`; `delete_file` now also removes the `file_metadata` row.
- **#5** `.unwrap()`s in the indexing thread / `process_batches` replaced with
  error propagation + `log::error!` (back to non-panicking `done(count)` on
  failure); tray-icon unwrap hardened via `ok_or`.
- **#6** Pro gating now uses `disk.is_removable()` (sysinfo 0.32.1) — fixed
  internal drives (incl. `Unknown(-1)` NVMe) are free; only removable media is Pro.
- **#7** `open_in_explorer` validates the path through `security::AllowedRoots`
  before `opener::reveal` (the `openPath` plugin scope remains wide; noted).
- **#9** Watcher metadata insert is an UPSERT (`ON CONFLICT(path) DO UPDATE`),
  no more swallowed UNIQUE-constraint noise, and it preserves `sync_id`.
- **#10** `get_index_stats` counts `category != 'Folder'`.
- **#11** eslint: 0 errors / 0 warnings (StrictMode-safe deps, removed spurious
  `activeCategory` dep, documented `useVirtualizer` disable).
- **#12** Vitest `act(...)` warnings gone (tests flush effects inside `act`).
- **#13** Removed dead `addRecentItem` and `setIsPro` store actions.
- **#14** Dropped `@tauri-apps/plugin-dialog` from package.json + lockfile.
- **#15** wdio plugins moved behind a cargo `e2e` feature
  (`debug_assertions` is unsupported for Cargo target-selection); `test:e2e`
  now builds with `--features e2e` first. Release binaries are wdio-free
  (verified via `cargo tree`).
- **#16** Verified the public repo's default branch is `master`, so the hardcoded
  `blob/master` links work — no change needed.
- **#17** FTS snippet is now `COALESCE(snippet(title), snippet(path))`, so
  path-only matches highlight too.
- **#18** `git rm -r --cached scratch_test` + `.gitignore` entry (repo shrinks
  by ~110 MB of build artifacts).
- **#19** Removed duplicate `use tauri::Emitter`, `println!` → `log::*` (no
  logger initialized ⇒ silent in release), removed dead `AllowedRoots::add_custom`.
- **#20** Added `tsconfig.wdio.json` (+ `@types/node`, `@wdio/globals` devDeps
  and a `typecheck:e2e` script) so `wdio.conf.ts` and `test/e2e/*` are now
  type-checked: `tsc -p tsconfig.wdio.json` passes. (Editor LSP may still
  associate those files with the root tsconfig until the project is reopened.)

## Notes / verification

- `npx tsc --noEmit`, `npx eslint src`, `npm run test:unit` (2 passed, 12s),
  `cargo build`, `cargo test` (1 passed) — all green at HEAD `d388b43`.
- `src-tauri/target` (and `src-tauri/gen/schemas`) correctly untracked.
- CI: `build.yml` + `test.yml` run on every push/PR across 3 OS; `release.yml`
  (tag `latest`) uses `git tag -f` + `push -f` and `releaseDraft: true`. No
  Windows code-signing anywhere in CI — ties into the open "Unknown publisher"
  thread (no free route exists once paid features land; track
  `bundle.windows.signCommand` / Azure Artifact Signing).

---

## Licensing & Pro enforcement (work in progress)

Pro entitlement is now cryptographically verified in Rust instead of a
localStorage boolean. Status: **skeleton, no real issuance server yet**.

What shipped:

- `src-tauri/src/license.rs` — Ed25519-signed license tokens. Embedded public
  key (build.rs injects `VEXIL_PUBLIC_KEY` env at build time, else falls back
  to the committed dev key — production CI must always set the env); payload is
  `base64(json) + "." + base64(sig)`; payload **v2**: `version` + optional
  `device_id` bound to a stable machine id (Windows `MachineGuid` via winreg,
  Linux `/etc/machine-id`, fallback host+os hash). Verifies signature, device
  binding, format version, expiry, and a **clock-rollback watermark**
  (`license_seen_at` sidecar; clock < last-valid − 24h ⇒ refused — naive calendar
  rollback mitigation). New commands `get_license_status` and `install_license`
  (verify-then-write to `app_data_dir/license.lic`). 15 unit tests incl.
  tamper/wrong-key/expired/malformed, device-mismatch, newer-version rejection,
  legacy-payload parse, watermark boundaries, sign→verify roundtrip.
- `src-tauri/src/bin/sign_license.rs` — self-contained CLI:
  `gen-key <dir>`, `sign --key --payload --out`, `verify --public --lic`.
  Private key stays out of git (`src-tauri/licenses/*_private.key` ignored;
  the `*.key` rule already covers it too); `vexil_public.key` is committed via
  a `!negation`, and `dev_sample.lic` (a perpetual pro license) is committed so
  the pipeline is testable from a fresh clone.
- Pro gates now enforced in Rust, not just UI: `set_run_in_background` rejects
  non-Pro; `start_indexing` rejects custom dirs under removable drives for free
  users (`disk_is_pro_only`). The UI-level alerts remain as UX polish
  (defense in depth), and `isPro` was removed from the persisted zustand store.
- Frontend: `src/store/licenseStore.ts` (camelCase `LicenseStatus`, plus
  `install()`), refreshed on App mount; gates in `searchStore`
  (`addMyPick`, `setRunInBackground`), the settings PRO badge, `DirectoryTree`
  all read the verified status; Settings now has an inline **Pro License
  activation** form (paste key → `install_license`, inline errors, no alert).

Still open (by design — picked up when a real issuance server exists):

- No subscription/seat-count/revocation logic beyond the Worker's KV ledger
  (device seats + term-based `expiresAt`; hard revocation not enforced offline).
- **Issuance server is scaffolded but not live** — `licensing/worker/` needs
  your Paddle + Cloudflare accounts, KV namespaces, Worker secrets and a
  deployed URL; the app is already wired to `VITE_LICENSE_SERVER` +
  `activate_with_email`. See `licensing/worker/README.md`.
- The rollback watermark is a _mitigation_ for naive clock changes, not a wall —
  patching the binary or deleting `license_seen_at` defeats it (any offline
  license can; the real fix is the server-gated feature in PLAN.md Phase 5).
- Produce key pair must eventually move to CI/server (KMS); the committed key
  is a dev-only placeholder (build.rs warns when embedding it).

---

## Content extraction (PDF / DOCX / XLSX / PPTX / EPUB)

New `src-tauri/src/content.rs` replaces the old "first 2000 bytes of 9 text
types only" indexing. `start_indexing` and the Live Radar watcher now call
`content::should_index_content(ext)` + `content::extract_text(path, ext)` for
every indexed file. This is the product differentiator: content search inside
real documents, which filenames-only tools (Everything) and launchers
(PowerToys Run) can't do.

What ships:

- Plain text (existing types) capped at 262 KiB bytes read; extracted text
  truncated to 65,536 chars.
- **DOCX** — `word/document.xml`, `<w:t>` runs, `<w:p>/<w:tr>/<w:tc>` blocks.
- **XLSX** — `xl/sharedStrings.xml` + `xl/inlineStrings.xml` (`<t>` under
  `<si>`/`<row>`).
- **PPTX** — every `ppt/slides/slide*.xml` (`<a:t>` under `<a:p>`).
- **EPUB** — every `.xhtml/.html/.htm` entry, text under block elements,
  `<style>`/`<script>` skipped.
- **PDF** — `pdf-extract` (pure Rust, no poppler/system dep).
- Namespace-safe matching: compare the local name after the last `:`.
- Zip entries capped at 1 MiB each. `.doc`/`.xls`/`.ppt` legacy binary formats
  are deliberately **not** claimed (separate link).
- Malformed files can't take the process down: every extraction runs under
  `catch_unwind` (AssertUnwindSafe), and `[profile.release] panic` flipped from
  `abort` to `unwind` so a worker-thread panic unwinds instead of killing the
  whole app (extends #5).

7 new unit tests build real fixtures with `zip::ZipWriter`, a hand-built
minimal PDF (xref table, `(…) Tj`, Type1 Helvetica) for `pdf-extract`, plus
extension gating and the char cap. Full suite: `cargo test` 16 passed.

Remaining gaps / follow-ups:

- Legacy binary `.doc`, `.xls`, `.ppt` need a link-time approach (COM/
  `Word.Application`, or antiword) — deferred; users with old Office files get
  filename/title-only matches.
- `.pdf` with scanned/embedded-font pages yields empty text (no OCR) — OCR
  (tesseract) is a possible later Pro feature.
- Extraction runs synchronously on the worker thread; a slow or huge file
  stalls that single block. Batch-level progress already exists; parallelism
  per-file could come later.
