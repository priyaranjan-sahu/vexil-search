// Vexil license issuance worker.
//
// - POST /webhook    Paddle Billing and Buy Me a Coffee webhook receiver
//                    (verified via HMAC; provider auto-detected or pinned).
// - POST /activate   `{ email, deviceId }` -> signed `.lic` token (device-bound).
// - POST /deactivate `{ email, deviceId }` -> frees a device seat.
// - GET  /health     liveness.
//
// Secrets (wrangler secret put):
//   PRIVATE_KEY             base64 32-byte RFC 8032 seed (prod signing key)
//   PADDLE_WEBHOOK_SECRET   Paddle Billing webhook signing secret
//   BMAC_WEBHOOK_SECRET     Buy Me a Coffee webhook signing secret
// [vars]:
//   WEBHOOK_PROVIDER        "paddle" | "buymeacoffee" | "auto" (default "auto")
//   BMAC_PRO_PRODUCT_ID     shop item id or title (comma-separated) that grants
//                           a Pro license; fail-closed when empty
//   BMAC_SUPPORT_MEMBERSHIPS "true" to also map active memberships to Pro
// KV namespaces:
//   CUSTOMERS  customer:<email>      -> { active, recurring, updatedAt }
//              hook:<provider>:<id>  -> dedupe marker (30-day TTL)
//   SEATS      seats:<email>         -> [deviceId, ...]

import {
  b64decode,
  signToken,
  normalizeEmail,
  verifyPaddleWebhook,
  verifyBmcWebhook,
  paddleEventState,
  bmcEventState,
  SEAT_LIMIT,
  PLAN,
  FEATURES,
  DAY_SECS,
} from "./lib.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Paddle-Signature, x-signature-sha256, x-bmc-signature",
};

function jsonOk(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function jsonError(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function preflight() {
  return new Response(null, { status: 204, headers: CORS });
}

function nowSecs() {
  return Math.floor(Date.now() / 1000);
}

async function readSeats(env, email) {
  const seats = JSON.parse((await env.SEATS.get(`seats:${email}`)) || "[]");
  return Array.isArray(seats) ? seats : [];
}

async function handleWebhook(request, env) {
  const raw = await request.text();

  const paddleSig = request.headers.get("Paddle-Signature") || "";
  const bmcSig =
    request.headers.get("x-signature-sha256") ||
    request.headers.get("x-bmc-signature") ||
    "";

  let provider = String(env.WEBHOOK_PROVIDER || "auto")
    .toLowerCase()
    .trim();
  if (provider === "auto") {
    if (paddleSig) provider = "paddle";
    else if (bmcSig) provider = "buymeacoffee";
    else return jsonError(401, "Missing webhook signature");
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return jsonError(400, "Invalid JSON body");
  }
  const type =
    provider === "paddle" ? event.event_type || "" : event.type || "";

  if (provider === "paddle") {
    const valid = await verifyPaddleWebhook(
      env.PADDLE_WEBHOOK_SECRET,
      raw,
      paddleSig,
    );
    if (!valid) return jsonError(401, "Invalid webhook signature");
  } else {
    const valid = await verifyBmcWebhook(env.BMAC_WEBHOOK_SECRET, raw, bmcSig);
    if (!valid) return jsonError(401, "Invalid webhook signature");
  }

  // De-duplicate retried deliveries (Paddle and BMAC both attach an event_id).
  const eventId = String(event.event_id || "").trim();
  const dedupeKey = eventId ? `hook:${provider}:${eventId}` : null;
  if (dedupeKey && (await env.CUSTOMERS.get(dedupeKey))) {
    return jsonOk({ received: true, duplicate: true, type });
  }

  const next =
    provider === "paddle"
      ? paddleEventState(event)
      : bmcEventState(event, {
          proProductId: env.BMAC_PRO_PRODUCT_ID,
          supportMemberships: env.BMAC_SUPPORT_MEMBERSHIPS === "true",
        });

  if (!next) {
    return jsonOk({ received: true, ignored: true, type });
  }

  const customerKey = `customer:${next.email}`;
  const record = {
    active: next.active,
    recurring: next.recurring ?? null,
    updatedAt: nowSecs(),
  };
  await env.CUSTOMERS.put(customerKey, JSON.stringify(record));

  if (dedupeKey) {
    await env.CUSTOMERS.put(dedupeKey, "1", {
      expirationTtl: 30 * DAY_SECS,
    });
  }
  return jsonOk({ received: true, type });
}

async function handleActivate(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonError(400, "Invalid JSON body");
  const email = normalizeEmail(body.email);
  const deviceId = String(body.deviceId || "").trim();
  if (!email || !deviceId)
    return jsonError(400, "email and deviceId are required");
  if (!/^[0-9a-f]{16}$/.test(deviceId)) {
    return jsonError(400, "invalid deviceId (expected 16 hex chars)");
  }

  const customer = JSON.parse(
    (await env.CUSTOMERS.get(`customer:${email}`)) || "null",
  );
  if (!customer?.active) {
    return jsonError(403, "No active license found for this email");
  }

  let seats = await readSeats(env, email);
  const exists = seats.includes(deviceId);
  if (!exists && seats.length >= SEAT_LIMIT) {
    return jsonError(
      403,
      `Device limit reached (${SEAT_LIMIT} devices per license)`,
    );
  }

  let expiresAt = null;
  if (customer.recurring) {
    const days = customer.recurring === "year" ? 365 : 30;
    expiresAt = nowSecs() + days * DAY_SECS;
  }

  const payload = {
    version: 2,
    userId: email,
    plan: PLAN,
    features: FEATURES,
    issuedAt: nowSecs(),
    expiresAt,
    deviceId,
  };
  const privateKey = b64decode(env.PRIVATE_KEY);
  const license = signToken(payload, privateKey);

  if (!exists) {
    seats.push(deviceId);
    await env.SEATS.put(`seats:${email}`, JSON.stringify(seats));
  }
  return jsonOk({ license });
}

async function handleDeactivate(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonError(400, "Invalid JSON body");
  const email = normalizeEmail(body.email);
  const deviceId = String(body.deviceId || "").trim();
  let seats = await readSeats(env, email);
  const before = seats.length;
  seats = seats.filter((d) => d !== deviceId);
  if (seats.length !== before) {
    await env.SEATS.put(`seats:${email}`, JSON.stringify(seats));
  }
  return jsonOk({ removed: seats.length !== before });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return preflight();
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health") return jsonOk({ status: "ok" });
      if (url.pathname === "/webhook" && request.method === "POST") {
        return handleWebhook(request, env);
      }
      if (url.pathname === "/activate" && request.method === "POST") {
        return handleActivate(request, env);
      }
      if (url.pathname === "/deactivate" && request.method === "POST") {
        return handleDeactivate(request, env);
      }
      return jsonError(404, "Not found");
    } catch (err) {
      console.error("worker error:", err);
      return jsonError(500, "Internal error");
    }
  },
};
