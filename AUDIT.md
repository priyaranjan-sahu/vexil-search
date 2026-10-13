# Vexil — Deep Codebase Audit

_Date: 2026-10-12 · Base: `master` @ `9d9034f` (audit follow-ups merged) · Method: full read of `src/`, `src-tauri/src/`, `licensing/worker/`, `.github/workflows/`, plus targeted verification against source._

This document is deliberately blunt. The goal is not to be nice — it is to
prevent a slow, invisible decline. Every bug below was read in the source. Where
a claim from earlier analysis could **not** be substantiated, it is listed in
[§4 Corrected / withdrawn claims](#4-corrected--withdrawn-claims) so future
audits don't re-chase ghosts.

Severity key: **S1** = data loss / money / security · **S2** = wrong behaviour or
degraded UX users will hit · **S3** = latent / perf / hygiene.

---

## 1. Executive summary

Vexil is a competent, unusually well-tested local-search desktop app for one
person's codebase. The Rust core is defensive (panic=unwind, per-file
`catch_unwind`, ed25519 licence checks, batched transactions). The licensing
worker is the weak point: it can be made to hand out Pro licences for free
(`transaction.completed` unfiltered) and to keep honouring refunded ones
(`subscription.updated` ignores status). The desktop packaging cannot actually
auto-update (updater artifacts are never built). And a handful of real logic
bugs remain in the indexer/parser and in the search-to-delete UI path.

None of this is fatal. All of it is fixable in days. The bigger risk is product
positioning — see [§5](#5-the-blunt-truth) — not the code.

---

## 2. Bug inventory

### S1 — money / security / data loss

#### 2.1 `transaction.completed` grants Pro regardless of product — **VERIFIED**

`licensing/worker/src/lib.js` (`paddleEventState`, ~L154–172). The handler sets
`active: true` for any `transaction.completed` event without checking that the
line item matches Vexil's product/price ID. Any Paddle transaction that reaches
the webhook — a different product on the same Paddle account, a test charge —
mints a Pro entitlement. **Impact:** revenue leak / unauthorized Pro.
**Fix:** allow-list `data.items[].price_id`; reject anything else.

#### 2.2 Refunds/cancellations keep Pro forever — **VERIFIED**

`licensing/worker/src/lib.js` L166–172: `subscription.updated` writes
`active: true` unconditionally and never inspects `data.status`. A `canceled`,
`past_due`, or `paused` subscription stays `active`. There is a `_deleted`/status
path that is not consulted. **Impact:** refunded users keep paid features; this
is exactly the scenario audit-follow-up item 2 tried to defend against, but the
webhook still feeds the store the wrong truth. **Fix:** map Paddle status
(`active`/`trialing` → true; everything else → false) before writing.

#### 2.3 `/activate` has no proof of email ownership — **VERIFIED**

`licensing/worker/src/index.js` (`/activate`, ~L207). Given a paid email and a
device id, the endpoint issues an activation with no OTP, magic-link, signed
token, or any secret the attacker must possess. Knowing a customer's email is
enough to consume their seats. Combined with 2.4 this is trivial. **Impact:**
seat theft, customer lockout. **Fix:** send a one-time code to the email (or
require a Paddle-provided customer portal token) before activating.

#### 2.4 Seats can be exceeded via read-modify-write race — **VERIFIED**

`licensing/worker/src/index.js` L236–243 (read) → L268–271 (write). The seat
array is `JSON.parse`-ed, mutated, and written back with no compare-and-set.
KV is eventually consistent, so two concurrent `/activate` calls both read
`len < 3` and both write, ending at 4+ seats. `/deactivate` has the same race in
reverse. **Impact:** `SEAT_LIMIT = 3` is not a real limit. **Fix:** Durable
Object per email (serialized), or D1 with a conditional UPDATE, or an atomic
counter key.

### S2 — wrong behaviour users will hit

#### 2.5 Indexer drops the rest of a batch on error and lies about it — **VERIFIED**

`src-tauri/src/lib.rs` `process_batches` (~L265–305). The batch body iterates
with `drain(..)` inside a closure; if one `execute` errors mid-batch, the
remaining drained items are dropped and `ROLLBACK` undoes the ones that ran. The
loop still increments `count`, so `indexing-done` reports a success number that
is larger than the rows actually written. Because changed-file old rows were
already deleted, the stale-row GC (`lib.rs` ~L391–398) then removes any that
survived. **Impact:** silent partial indexing; user cannot trust "N files
indexed". **Fix:** build the batch by reference, commit per item or track a
committed count, and report real numbers.

#### 2.6 Short-query `LIKE` does not escape `%` / `_` — **VERIFIED**

`src-tauri/src/lib.rs` (~L452): `format!("%{}%", trimmed_query)` is passed to
SQL `LIKE` with no escaping. A query containing `%` or `_` becomes a wildcard;
`_` matches any single char. **Impact:** surprising/misleading results for
queries with those characters. **Fix:** escape `\ % _` and add `ESCAPE '\'`.

#### 2.7 Search silently caps at 50 with no pagination or "more" signal — **VERIFIED**

`src-tauri/src/lib.rs` L448, L495, L546 all end in `LIMIT 50`; `BROWSE_LIMIT =
50` (L622). There is no `offset`, no "load more", and no UI hint that results
were truncated. **Impact:** for a real document library the top-50 cut looks
like "these are all your matches". **Fix:** keyset pagination + a "showing 50 of
N" affordance; the backend already computes counts elsewhere.

#### 2.8 Deleting can act on a row the user can no longer see — **VERIFIED**

`src/App.tsx` ~L336–338: the live-search effect depends on
`[searchQuery, activeCategory, runSearch]` — **not** `activeSizeFilter` /
`activeDateFilter`. Filters are applied purely client-side
(`filteredResults`, `App.tsx` ~L393–446; browse ~L455–472). Changing only a
size/date filter never re-queries, so the previously selected row can vanish
from view while `selectedResult` still points at it. The toolbar Delete
(`App.tsx` ~L868–905) and `handleDelete` (`src/store/searchStore.ts` L301–328)
then delete `selectedResult`, i.e. an invisible file. The confirm dialog does
name the file, which is the only thing standing between this and a genuine data
loss bug. **Fix:** clear `selectedResult` whenever the visible set changes, and
gate delete on the row still being visible.

#### 2.9 Parser leaks depth on self-closing tags; DOCX/CDATA text lost — **VERIFIED**

`src-tauri/src/content.rs` ~L240–281. `Event::Start` and `Event::Empty` both
increment `scope_depth` / `skip_depth`, but only `Event::End` decrements. Any
self-closing tag (extremely common in OOXML/XHTML) permanently inflates the
depths, so the "insert block separator" branch (`scope_depth > 0`) never fires
and DOCX runs together; CDATA content is dropped by the `_ => {}` arm at ~L277.
**Impact:** poor snippets/extraction for DOCX and self-closing-heavy XML/RSS.
**Fix:** don't increment on `Event::Empty`; handle `Event::CData`.

#### 2.10 Virtual results table mis-sized rows — **VERIFIED**

`src/components/ResultsTable.tsx` L180 `estimateSize: () => 48` (comment claims
"~40px") while `.data-table td` is `padding: 8px 16px` with a ~1rem line
(`src/App.css` L335), i.e. ~34px rendered. The table uses the spacer-row
technique (`ResultsTable.tsx` L301–357) with non-absolutely-positioned rows, so
a 40% overestimate makes the scroll offset drift from the rendered content:
blank gaps and jumpy scrolling on large result sets. **Fix:** measure rows
(`measureElement`) or set the estimate to the real height and keep them in sync.

#### 2.11 Updater artifacts are never built → auto-update is dead — **VERIFIED**

`src-tauri/tauri.conf.json`: the `updater` block (endpoint + `pubkey`) exists
(~L42–49) but `bundle` (~L31–41) has no `createUpdaterArtifacts: true`, and no
workflow sets `TAURI_SIGNING_*`. Tauri therefore never produces the signed
update artifacts or `latest.json`. **Impact:** shipped desktop builds can never
update themselves, even though the UI implies they can. **Fix:** enable the flag
and wire `TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD` into the build jobs.

### S3 — latent / perf / hygiene

#### 2.12 Unbounded memory if `BEGIN` fails — **VERIFIED**

`src-tauri/src/lib.rs` ~L275–278: if the batch `BEGIN` fails, the pending-vector
buffer is never drained and keeps growing each tick. **Impact:** OOM under a
persistent DB error. **Fix:** drain/drop on the error path.

#### 2.13 REGEXP is recompiled per row — **VERIFIED**

`src-tauri/src/db.rs` L42–46 registers a `REGEXP` function that compiles the
regex on every invocation (per row). **Impact:** query cost scales with row
count. **Fix:** cache compiled regexes (bounded LRU) or precompile per query.

#### 2.14 `path_is_indexed` vs `delete_file` disagree on path form — **VERIFIED**

`src-tauri/src/lib.rs` `path_is_indexed` (~L1028–1038) matches `canonical OR
raw`, but `delete_file` (~L1080–1084) deletes using only the canonical form.
Files indexed under the raw form therefore leave stale rows that the GC cannot
reconcile. **Impact:** ghost rows / re-index churn. **Fix:** normalise
consistently at both sites.

#### 2.15 Slow `#[tauri::command]`s are synchronous → UI freezes — **VERIFIED**

Several commands that do real I/O (search, index kicks, file ops) are defined
sync, so Tauri runs them on the main/UI thread. **Impact:** the window stalls on
slow disks/large libraries. **Fix:** make them `async` or move work to a
`spawn_blocking`/worker thread.

#### 2.16 `runInBackground` pushed to backend without a licence gate — **VERIFIED**

`src/App.tsx` ~L201–205 pushes the persisted `runInBackground` on mount with no
`hasFeature(FEATURES.background)` check. Default is `false`
(`searchStore.ts` L124), so only previously-enabled users are affected — but a
lapsed licence keeps a paid feature turned on until the user re-toggles.
**Fix:** gate the mount push on entitlement.

#### 2.17 `ACTIVATE_PER_EMAIL` (5) exceeds `SEAT_LIMIT` (3) — **VERIFIED**

`licensing/worker/src/index.js` L44 vs the seat constant. A script can consume
all seats within one rate window. **Fix:** make the per-email budget < seats, or
drop it in favour of the real fix in 2.4.

#### 2.18 Rate limiter is non-atomic — **VERIFIED**

`licensing/worker/src/lib.js` L72–81: read-modify-write on a KV counter, same
race as 2.4. **Impact:** limits are advisory only. **Fix:** Durable Object/atomic
increment.

#### 2.19 Wide-open CORS on state-changing endpoints — **VERIFIED**

`licensing/worker/src/index.js` L49–54: `Access-Control-Allow-Origin: *` on all
responses including `/activate`, `/deactivate`, `/verify`. **Fix:** restrict to
the app origins; these shouldn't be browser-callable from anywhere anyway.

#### 2.20 Packaging & CI hygiene — **VERIFIED**

- No Windows code-signing config in `tauri.conf.json` → unsigned installers
  (SmartScreen warnings, worse install conversion).
- CSP (`tauri.conf.json` L28) lacks `object-src` / `frame-ancestors`.
- Workflows pin actions to mutable tags (`actions/checkout@v4`,
  `dtolnay/rust-toolchain@stable`) and run `npm audit … || true` /
  `cargo audit || true` (`builder.yml` L92, L94) — audits that can never fail a
  build are security theatre. **Fix:** pin to SHAs, make audits blocking (or
  explicitly tracked), add signing.

---

## 3. What is genuinely good

- Rust release profile: `panic = "unwind"` + per-file `catch_unwind` so a
  malformed document can't kill a long index run.
- Licence tokens are ed25519-signed and verified in Rust, with a clean
  `has_feature` / `entitlements` split so UI and backend can't disagree.
- Batch inserts, prepared statements, WAL-ish usage, and a real stale-row GC.
- Test depth is far above the norm for a project this size: 94 Rust lib tests,
  106 vitest tests, worker webhook/verify/security/compat suites, and CI that
  actually runs lint + tests across five OS targets.
- The audit follow-ups (#22, #23) closed real bugs (trash, content, indexing,
  licence revocation, startup panics, theme flash) rather than papering over.

---

## 4. Corrected / withdrawn claims

These appeared in earlier exploratory analysis and are **not** supported by the
source. Recorded so they are not re-reported:

- **"Frontend truncates search to 100 results"** — no such slice exists. The
  real cap is `LIMIT 50`, server-side (§2.7).
- **"A `minSimilarity` gate drops good results."** — no `minSimilarity` /
  `min_similarity` symbol exists anywhere in `src/` or `src-tauri/src/`.
- **"Mobile has its own separate search invocation with different limits."** —
  `MobileApp.tsx` L216–219 calls the same store `runSearch`; there is no
  second path.
- **"`panic = "abort"` in release."** — the manifest sets `panic = "unwind"`
  (`Cargo.toml` L69); this was already fixed before this audit.

---

## 5. The blunt truth

The engineering is fine. The **product thesis is the risk.**

Local file search is a graveyard. Windows Search, Everything, Spotlight,
Alfred, Raycast, Launchy, DocFetcher, Recoll, Copernic, Listary — the list of
"search your own files" products that either died, went free, or got absorbed is
longer than the list of survivors. Four hard lessons from that graveyard map
directly onto Vexil's current shape:

1. **"Search your files" is a feature, not a product.** Everything and Spotlight
   proved the ceiling: power users expect it free, and everyone else never
   installs it. Vexil currently leads with search. It needs a wedge that search
   alone never had — the paid licensing, the "Live Radar", "My Picks", and
   background watching are steps toward one, but they read as features on top of
   a commodity, not a reason to exist.
2. **Distribution beats capability.** The dead products weren't worse — they
   were un-tellable. Vexil has no story for how a stranger hears about it, tries
   it in 30 seconds, and tells a colleague. Fix onboarding-to-first-win before
   adding surface area.
3. **Local-only is a trust story, not a value story.** "Your files never leave
   your device" is a great objection-handler and a terrible first sentence.
   Lead with the outcome ("find the clause in that PDF you half-remember from
   2019, in under a second"), keep privacy as the closer.
4. **Grotesque file-format coverage is the actual moat.** The parser bugs in
   §2.9 matter more than they look: the products that survived did so because
   they extracted _anything_ — scanned PDFs (OCR), old Office formats, email
   (PST/MBOX/EML), chat exports, source, notes apps. Search quality on messy
   real-world data is the differentiator search engines can't match.

Blunt verdict: **the code is ready to be trusted; the positioning is not ready
to be bought.** Spend the next cycle on §2.1–2.4 (stop the money leak), §2.11
(actually ship updates), and §2.5–2.8 (trust in the index), then pivot the
roadmap toward outcomes and format coverage rather than more search knobs.

---

## 6. Top 10 features to build next

Ordered by expected impact on retention and willingness-to-pay, not effort.

1. **Content-first search that just works.** Make the §2.9 parser fixes and add
   OCR for scanned PDFs/images. This is the surviving products' moat.
2. **Format breadth.** Email (`.eml`/`.mbox`/PST), legacy Office (`.doc`/`.xls`),
   Markdown/Notion/Obsidian exports, iWork. "It found it in my old .doc" is a
   word-of-mouth moment.
3. **Semantic + keyword hybrid.** Trigram/keyword is table stakes; add a local
   embedding (or a hybrid re-ranker) so "the invoice where they tried to sneak
   in a renewal clause" works. Keep it offline.
4. **First-run "wow" onboarding.** Index a chosen folder, then show an instant
   hit on something the user forgot they had — in under 60 seconds. This fixes
   lesson #2.
5. **Real auto-update + signed installers** (§2.11, §2.20). Without this every
   other feature ships to a shrinking share of users.
6. **Saved searches + smart folders.** Turn one-off searches into durable
   objects users rely on daily (and feel they'd lose).
7. **Instant preview / quick actions.** Preview pane with scroll-to-match, plus
   rename/move/tag/share-in-place. Reduces the "search → open → hunt" tax.
8. **Fast, correct, paginated search** (§2.7, §2.10). Perceived speed is a
   feature; a jumpy table and a silent 50-result cap read as "slow and wrong".
9. **OCR everything, then index it.** Overlaps #1 but deserves its own line:
   screenshots, scans, and photos are where rivals give up and users feel pain.
10. **Team/seek-and-share (paid tier).** The durable monetisation is not one
    power user at $X — it's a small team that wants to find each other's files
    (opt-in, local-first, encrypted). This is also the honest reason a
    subscription exists.

---

_Verification note: every S1/S2 finding was confirmed by reading the named
source. Perf/hygiene items (S3) were confirmed by reading except where noted as
"advisory". This document is the record of what is true; if code changes,
re-verify before quoting._
