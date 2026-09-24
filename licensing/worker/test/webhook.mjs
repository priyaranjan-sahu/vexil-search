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

const replayedTs = await verifyPaddleWebhook(
  secret,
  body,
  `ts=${String(Number(ts) - 60)};h1=${h1}`,
);
check("replayed timestamp rejected", replayedTs === false);

const malformed = await verifyPaddleWebhook(secret, body, "garbage");
check("malformed header rejected", malformed === false);

const missing = await verifyPaddleWebhook(secret, body, "");
check("missing header rejected", missing === false);

if (failures > 0) process.exit(1);
console.log("PASS: webhook signature verification");
