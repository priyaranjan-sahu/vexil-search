// End-to-end licensing check for Vexil.
//
//   node verify-license.mjs <PADDLE_WEBHOOK_SECRET> [worker-url]
//
// Proves three things in one shot, in the order they depend on each other:
//   1. the worker's PADDLE_WEBHOOK_SECRET matches the one you pass in
//   2. a signed Paddle webhook is accepted and grants Pro
//   3. the license the worker signs verifies against the production
//      public key baked into release builds
//
// Step 3 is the one that cannot be checked any other way, because a
// mismatched PRIVATE_KEY would only surface when a customer tried to
// activate.
//   node verify-license.mjs <PADDLE_WEBHOOK_SECRET> [worker-url] [public-key-b64]
//
// The third argument defaults to the production public key that release
// builds embed. It exists only so this can be exercised against a local
// worker with the repo's dev key; leaving it off is what you want for a
// real check.
import { createHmac, createHash } from "node:crypto";

const PROD_PUBLIC_KEY_B64 =
  process.argv[4] || "xj4kxCJfCHexp7YkrkloOxihA5SGn7NQBT6aCZboRYY=";
const secret = process.argv[2];
const base = (
  process.argv[3] || "https://vexil-licenses.cerebrix-labs.workers.dev"
).replace(/\/$/, "");
const email = `licence-check-${createHash("sha256").update(secret).digest("hex").slice(0, 10)}@example.com`;
const deviceId = createHash("sha256")
  .update("vexil-check")
  .digest("hex")
  .slice(0, 16);

const fail = (m) => {
  console.error(`FAIL  ${m}`);
  process.exit(1);
};
const ok = (m) => console.log(`ok    ${m}`);
// Cloudflare's error pages are ~40 kB of HTML; never dump one.
const brief = (t) =>
  t.trim().startsWith("{")
    ? t.trim()
    : t
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160) + " [html error page]";

if (!secret)
  fail("usage: node verify-license.mjs <PADDLE_WEBHOOK_SECRET> [worker-url]");
console.log(`worker: ${base}`);
console.log(`email : ${email}\n`);

// ---- 1. send a correctly signed Paddle webhook ------------------------------
const body = JSON.stringify({
  event_id: `evt_${createHash("sha256").update(email).digest("hex").slice(0, 24)}`,
  event_type: "transaction.completed",
  data: {
    customer: { email },
    items: [{ price: { billing_cycle: { interval: "month" } } }],
  },
});
const ts = Math.floor(Date.now() / 1000);
const h1 = createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex");

const hook = await fetch(`${base}/webhook`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Paddle-Signature": `ts=${ts};h1=${h1}`,
  },
  body,
});

const hookText = await hook.text();
if (hook.status === 401)
  fail(
    `worker rejected the signature (${brief(hookText)}). The Paddle secret on the worker is not the one you passed in. Re-run: npx wrangler secret put PADDLE_WEBHOOK_SECRET`,
  );
if (!hook.ok) fail(`webhook returned ${hook.status}: ${brief(hookText)}`);
if (/ignored/.test(hookText)) fail(`webhook was ignored: ${brief(hookText)}`);
ok(`webhook accepted  ${brief(hookText)}`);

// ---- 2. activate and check it really granted Pro ---------------------------
const act = await fetch(`${base}/activate`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, deviceId }),
});
const actText = await act.text();
if (act.status !== 200)
  fail(`activate returned ${act.status}: ${brief(actText)}`);
const token = JSON.parse(actText).license;
if (!token) fail(`no license in response: ${brief(actText)}`);
ok("license issued");

// ---- 3. verify it against the production public key -----------------------
const { ed25519 } = await import("@noble/curves/ed25519");
const [payloadB64, sigB64] = token.split(".");
const verified = ed25519.verify(
  Buffer.from(sigB64, "base64"),
  Buffer.from(payloadB64, "base64"),
  Buffer.from(PROD_PUBLIC_KEY_B64, "base64"),
);
if (!verified)
  fail(
    "license does NOT verify against the production public key. The worker's PRIVATE_KEY does not match the key in VEXIL_PUBLIC_KEY. Do not ship.",
  );
const claims = JSON.parse(Buffer.from(payloadB64, "base64").toString());
ok("signature verifies against the production public key");
console.log(`\n      expires  : ${claims.expiresAt}`);
console.log(
  `      features : ${JSON.stringify(claims.features ?? claims.entitlements)}`,
);
console.log(`      device   : ${claims.deviceId}`);
console.log(`\nPASS  the full licensing chain works.`);
