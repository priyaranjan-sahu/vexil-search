# vexil-licenses — Cloudflare Worker

Serverless license issuance for Vexil. Checkout/monetization can run through
**Paddle** (Merchant of Record — owns sales-tax/fraud liability) and/or **Buy Me
a Coffee** (No-code $0 on-ramp — you own VAT/GST, so Paddle is the long-term
home). Both send webhooks here; the Worker verifies them, records who paid,
then signs device-bound Ed25519 licenses with the app's existing verifier
format. The webhook provider is auto-detected from the signature header
(`WEBHOOK_PROVIDER = "auto"`).

Endpoints:

| Method | Path          | Purpose                                                |
| ------ | ------------- | ------------------------------------------------------ |
| POST   | `/webhook`    | Paddle **and** Buy Me a Coffee webhook (HMAC-verified) |
| POST   | `/activate`   | `{email, deviceId}` → signed `.lic` token, seat-linked |
| POST   | `/deactivate` | `{email, deviceId}` → free a seat                      |
| GET    | `/health`     | liveness                                               |

Safety properties:

- **You cannot mint a free license.** `/activate` only honors emails recorded by
  a verified webhook (Paddle or BMAC). Unverified → `403`.
- **BMAC fail-closed.** A BMAC purchase only grants Pro when it contains an item
  matching `BMAC_PRO_PRODUCT_ID`. Donations, and purchases of other items, are
  ignored — a $1 coffee can never mint a Pro license.
- **Refunds revoke.** `extra_purchase.refunded` (and Paddle cancellation
  events) flip the customer record to inactive.
- **Idempotent webhooks.** Both providers retry failed deliveries; retried
  events are dropped via a KV dedupe marker (`hook:<provider>:<event_id>`,
  30-day TTL).
- **Device-bound.** A token carries `deviceId`; the app refuses it on any other
  machine (`license.rs`).
- **Seat cap.** Max 3 devices per email (constant `SEAT_LIMIT` in `src/lib.js`).
- **Renewal.** Re-activating an existing device refreshes `expiresAt`
  (`now + 30/365d`); the app auto-renews in the last 30 days.
- **One-time purchases** (`recurring: null`) get a perpetual token.

## The signing key must match the app build

The Worker signs with an RFC 8032 Ed25519 seed. The _public_ half is embedded in
the app at build time via `src-tauri/build.rs` (`VEXIL_PUBLIC_KEY`, base64). The
formats are byte-identical with Rust's `ed25519-dalek` — proven bidirectionally by
`npm test` (`test/compat.mjs`) against the repo's dev keypair.

## First-time setup (Cloudflare)

Prereqs: Node 18+, npm, and a Cloudflare account. Install wrangler:

```bash
npm i -g wrangler
wrangler login
```

```bash
cd licensing/worker
npm install                       # installs deps + wrangler
wrangler kv namespace create CUSTOMERS   # copy the id
wrangler kv namespace create SEATS       # copy the id
```

Put both namespace ids into `wrangler.toml` (`id` and `preview_id`).

Generate the **production keypair** (do this once; the private half is a Worker
secret, never committed — `*.key` is gitignored):

```bash
node src/gen-key.mjs licenses-prod
```

- `licenses-prod/vexil_public.key` → base64 of the 32-byte public key. This is
  what `VEXIL_PUBLIC_KEY` must be in CI when building the app.
- The script prints `PRIVATE_KEY` once. Store it somewhere safe (password
  manager) **and** set it as the Worker secret:

```bash
wrangler secret put PRIVATE_KEY
# paste the base64 seed printed by gen-key.mjs
```

Set the webhook secrets (placeholders now; real values come from Paddle/BMAC
below):

```bash
wrangler secret put PADDLE_WEBHOOK_SECRET
wrangler secret put BMAC_WEBHOOK_SECRET
```

The webhook behaviour is configured via `[vars]` in `wrangler.toml`:

| Var                        | Default   | Meaning                                                                               |
| -------------------------- | --------- | ------------------------------------------------------------------------------------- |
| `WEBHOOK_PROVIDER`         | `"auto"`  | `paddle` / `buymeacoffee` / `auto` (auto-detects by header)                           |
| `BMAC_PRO_PRODUCT_ID`      | `""`      | BMAC shop item id **or** title (comma-separated) that grants Pro; empty = fail closed |
| `BMAC_SUPPORT_MEMBERSHIPS` | `"false"` | `"true"` to map active BMAC memberships to Pro too                                    |

Deploy:

```bash
npm run deploy        # wrangler deploy
# -> https://vexil-licenses.<your-subdomain>.workers.dev  ← LICENSE_SERVER
```

Local dev (no deploy needed for testing, KV emulated locally):

```bash
npm run dev           # http://localhost:8787
curl http://localhost:8787/health   # {"status":"ok"}
```

## First-time setup (Paddle)

1. Create a Paddle seller account → **Billing** (their billing suite).
2. Developer tools → **Webhooks** → **Add destination**:
   URL `https://vexil-licenses.<your-subdomain>.workers.dev/webhook`,
   events: `transaction.completed`, `subscription.activated`,
   `subscription.updated`, `subscription.canceled`, `subscription.past_due`,
   `subscription.paused`, `subscription.ended`. Use the **Billing API** endpoint
   style (signed with `Paddle-Signature`).
3. Copy the webhook **signing secret**, then:
   `wrangler secret put PADDLE_WEBHOOK_SECRET` again with the real value, and
   `wrangler deploy`.
4. Create a product: Pro tier. Add prices: monthly subscription, yearly
   subscription, and a one-time "Lifetime Pro" price.

## First-time setup (Buy Me a Coffee)

1. Create your BMAC page → **Shop** → add an _Extra_ item, e.g.
   **"Vexil Pro License"** (one-time, ~$20).
2. Integrations → **Webhooks** → **Add destination**:
   URL `https://vexil-licenses.<your-subdomain>.workers.dev/webhook`.
3. Copy the webhook's **signing secret**, then:
   `wrangler secret put BMAC_WEBHOOK_SECRET`.
4. Set `BMAC_PRO_PRODUCT_ID` in `wrangler.toml` to your item's **id** or
   **title** (title matching is case-insensitive; comma-separate for several),
   then `npm run deploy`.

   > The BMAC webhook payload identifies items only by their `id` and `title`
   > inside `data.extras[]` — there is no product-code field. Use the numeric id
   > if you have it (shown in the Shop item URL), otherwise the exact title.

5. Optional: set `BMAC_SUPPORT_MEMBERSHIPS = "true"` to let active memberships
   also mint/keep Pro licenses (a monthly supporter gets Pro while the
   membership is `active`; cancelled/paused revokes).

**BMAC is not a Merchant of Record.** There is no `live_mode` filtering on the
Worker — it trusts the signature. For a paid product, disable test mode before
going live and treat the webhook events themselves as the source of truth
(they carry `live_mode` if you ever want to filter). Paddle remains the
long-term checkout because it handles VAT/GST, fraud, and chargebacks for you.

## End-to-end test (sandbox)

1. Paddle sandbox: buy the monthly subscription as a test customer (no real money).
2. Paddle sends `subscription.activated` → Worker records the email in KV.
3. App side (`VITE_LICENSE_SERVER=http://localhost:8787`, dev):
   Preferences → Pro License → "Email used at checkout" → Activate.
4. The token installs (verify via the 🏅 ACTIVE badge / expiry date) and is
   bound to `get_device_id()`. Activating a second _different_ machine needs a
   second seat; the 4th device on the same email is refused.

## Shipping to production

- App build: set `VITE_LICENSE_SERVER` to the deployed worker URL, and
  `VEXIL_PUBLIC_KEY` to `licenses-prod/vexil_public.key` in CI. Never bake the
  sandbox/dev key into a shipped build.
- Keep `PADDLE_WEBHOOK_SECRET`, `BMAC_WEBHOOK_SECRET`, and `PRIVATE_KEY`
  rotating via `wrangler secret` only (never in `wrangler.toml`).

## Tests

```bash
npm test   # cross-impl crypto compat + Paddle + BMAC webhook verification
```

Deployed-worker smoke test:

```bash
curl -X POST https://vexil-licenses.<your-subdomain>.workers.dev/activate \
  -H "Content-Type: application/json" \
  -d '{"email":"nobody@example.com","deviceId":"0000000000000000"}'
# -> 403 {"error":"No active license found for this email"}   (expected)
```

## Known limitations / future work

- `expiresAt` is duration-based (issued + term); cancellation drains active
  value but a token can't be revoked before its stamp expires — acceptable for
  the current model (renewal is the enforcement point). Hard revocation is
  possible later via a KV "deny list" the app polls.
- Stale seats are never pruned automatically; a cancelled subscription's seats
  persist in KV until manually cleaned.
- No rate limiting yet on `/activate` beyond Cloudflare defaults (it only issues
  to paid emails, so abuse surface is small, but add a rate limiter before
  launching a paid tier prominently).
