# Vexil — Phase Plan

Direction (from earlier decisions): content search is the differentiator; licensing
is client-side crypto (a floor, not a wall); the uncrackable Pro gate must be a
server-gated feature later. Build revenue infrastructure first, then the big feature.

Phases are executed one at a time. Each phase ships fully green
(`cargo test`, `tsc`, `eslint`, `vitest`, `cargo check --release`) before the next starts.

---

## Phase 1 — Issuance-ready license plumbing (repo-side, no accounts needed)

Make the existing crypto skeleton actually shippable: real key separation, device
binding, and a rollback watermark.

- [x] Build-time public-key injection: `build.rs` embeds `VEXIL_PUBLIC_KEY` env (base64)
      when set, else falls back to committed `licenses/vexil_public.key`. Production
      builds must never embed the dev sandbox key.
- [x] Payload v2: `version`, optional `device_id` (bound to a stable machine id —
      Windows `MachineGuid` via winreg, Linux `/etc/machine-id`, fallback host+os).
- [x] Rollback watermark: sidecar `license_seen_at` stores last valid wall-clock;
      clock earlier than `watermark - 24h` ⇒ license refused (naive calendar rollback
      mitigation). Monotonic; only updated while license verifies.
- [x] Version gating: reject payloads newer than the app understands.
- [x] `sign_license` CLI: supports v2 payload + optional `--device` binding.
- [x] Settings → "Pro License": paste + activate UI with inline status/errors (no raw alert).
- [x] Tests: device-mismatch rejection, self-binding acceptance, newer-version rejection,
      legacy payload parse, watermark rollback logic.

Gate: license plumbing is provable and UI-complete; still no issuance server (that's Phase 2).

## Phase 2 — Monetization backend (needs your vendor signup/secrets)

Vendor: **Paddle (checkout + MoR taxes + webhooks) → Cloudflare Worker signer**
(no Keygen overhead — local crypto + device-binding already built).

Worker scaffolded and tested in-repo (`licensing/worker/`):

- [x] `POST /webhook` — Paddle Billing webhook, HMAC-verified, records paid
      customer + subscription term into KV.
- [x] `POST /activate` — `{email, deviceId}` → device-bound v2 `.lic`, seat
      capped (3/email), renewable; unissued emails → 403 (cannot self-mint).
- [x] `POST /deactivate`, `GET /health`; CORS; `wrangler.toml` + `gen-key.mjs`.
- [x] Crypto cross-compat proven: Worker (`@noble/curves`) ↔ app
      (`ed25519-dalek`) sign/verify bidirectionally against real keys.
- [x] App issuance flow: `get_device_id` command, `LicenseStatus.userId`,
      licenseStore `activateWithEmail`, Settings email form, silent renew in
      the last 30 days of a subscription.
- [ ] **Sign up** Paddle + Cloudflare; create KV namespaces; set
      `PRIVATE_KEY` + `PADDLE_WEBHOOK_SECRET`; deploy; wire Paddle webhooks.
      → see `licensing/worker/README.md`.
- [ ] Verify with a real $0/test purchase through the app.
- [ ] Set `VITE_LICENSE_SERVER` + `VEXIL_PUBLIC_KEY` (prod) in CI for shipped builds.

## Phase 3 — Code signing + publication (needs cert/signup + ~$10/mo)

- Azure Trusted Signing wired and CI-ready:
  - `src-tauri/tauri.windows.conf.json` — signed-delivery overlay setting
    `bundle.windows.signCommand` (object form) → `artifact-signing-cli`, pinned
    v0.11.0. Only applied on the windows matrix row via
    `tauri-action args: --config ...`; local/dev builds are untouched.
  - `.github/workflows/release.yml` — installs the CLI, feeds
    `AZURE_CLIENT_ID/SECRET/TENANT_ID` secrets, and after bundling runs
    `scripts/sign-installers.ps1` to sign the WiX `.msi` (Tauri only signs
    .exe/.dll) and verify every Windows deliverable is signed — a failure
    aborts the draft release, so unsigned installers never ship.
- Post-approval, one-time setup (no repo code changes):
  1. Fill the `<YOUR_...>` placeholders in `tauri.windows.conf.json` with the
     account + Public Trust certificate profile names; adjust `-e` if not
     West US 2.
  2. Add the three `AZURE_*` secrets to the repo (Public Trust profile
     approval is the ~1-2 week step).
  3. `cargo build --release` (or `npm run tauri build`) once locally with the
     secrets + config set, then `scripts/sign-installers.ps1` to smoke-test
     signing the produced .msi before trusting CI.
- Publish first real draft release; start SmartScreen reputation grind.
- Free tier: no feature degradation while unsigned — signing only matters once
  charging (Phase 2 live).

## Phase 4 — Quality bar + differentiator visibility

- Actually run the e2e suite (only type-checked so far) and make it pass in CI.
- Results UI must surface _why_ a file matched: "content match" + snippet vs
  path/title only — the content-search moat needs to be visible, not implicit.
- Perf pass: per-file parallel extraction, progress slowdowns, big-locale tuning.

## Phase 5 — AI Q&A (server-gated Pro, the uncrackable differentiator)

- Local RAG over the FTS5 index (chunking + embeddings) for offline-ish Q&A.
- Server-gated cloud Q&A endpoint, paid; Pro feature flags become server-authoritative.
- This is both the revenue justification and the reason license-patching stops working.

---

Notes:

- Legacy `.doc/.xls/.ppt` content extraction and OCR are deferred (low payoff);
  revisit only if content search gets user complaints about missing formats.
- Clock rollback watermark is a _mitigation_, not a wall — see BUGS.md licensing section.
