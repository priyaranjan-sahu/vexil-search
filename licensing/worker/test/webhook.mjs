// Verifies Paddle Billing webhook signature verification with a fabricated
// signature, mirroring how Paddle signs real webhooks:
//   Paddle-Signature: ts=<unix>;h1=<hex HMAC-SHA256 of "<ts>:<body>">
// Run inside the worker dir:  node test/webhook.mjs

import { createHmac, createHash } from "node:crypto";
import { verifyPaddleWebhook } from "../src/lib.js";

const secret = "webhook-secret";
const body = JSON.stringify({ event_type: "transaction.completed", data: {} });
const ts = String(Math.floor(Date.now() / 1000));
const message = `${ts}:${body}`;
const h1 = createHmac("sha256", secret).update(message).digest("hex");

let failures = 0;
function check(name, cond) {
  if (!cond) {
    console.error(`FAIL: ${name}`);
    failures += 1;
  } else {
    console.log(`ok: ${name}`);
  }
}

const good = await verifyPaddleWebhook(secret, body, `ts=${ts};h1=${h1}`);
check("valid signature accepted", good === true);

const badSecret = await verifyPaddleWebhook(
  "wrong-secret",
  body,
  `ts=${ts};h1=${h1}`,
);
check("wrong secret rejected", badSecret === false);

const tampered = await verifyPaddleWebhook(
  secret,
  body.replace('"event_type"', '"eventType"'),
  `ts=${ts};h1=${h1}`,
);
check("tampered body rejected", tampered === false);

// A correctly-signed but old delivery must be rejected as stale, otherwise a
// captured webhook replays forever.
const sign = (t) =>
  createHmac("sha256", secret).update(`${t}:${body}`).digest("hex");

const now = Math.floor(Date.now() / 1000);
const staleTs = String(now - 3600);
const stale = await verifyPaddleWebhook(
  secret,
  body,
  `ts=${staleTs};h1=${sign(staleTs)}`,
);
check("stale (but validly signed) delivery rejected", stale === false);

// The same stale delivery is accepted once the window is widened, proving the
// rejection above came from the freshness check and not a bad signature.
const staleAllowed = await verifyPaddleWebhook(
  secret,
  body,
  `ts=${staleTs};h1=${sign(staleTs)}`,
  { now, maxSkewSecs: 7200 },
);
check("stale delivery accepted within a widened window", staleAllowed === true);

const futureTs = String(now + 3600);
const future = await verifyPaddleWebhook(
  secret,
  body,
  `ts=${futureTs};h1=${sign(futureTs)}`,
);
check("future timestamp beyond skew rejected", future === false);

const edgeTs = String(now - 300);
const edge = await verifyPaddleWebhook(
  secret,
  body,
  `ts=${edgeTs};h1=${sign(edgeTs)}`,
  { now },
);
check("timestamp exactly at the window edge accepted", edge === true);

const malformed = await verifyPaddleWebhook(secret, body, "garbage");
check("malformed header rejected", malformed === false);

const missing = await verifyPaddleWebhook(secret, body, "");
check("missing header rejected", missing === false);

if (failures > 0) process.exit(1);
console.log("PASS: webhook signature verification");
