// Vexil license issuance worker.
//
// - POST /webhook    Paddle Billing webhook receiver (verified via HMAC).
// - POST /activate   `{ email, deviceId }` -> signed `.lic` token (device-bound).
// - POST /deactivate `{ email, deviceId }` -> frees a device seat.
// - GET  /health     liveness.
//
// Secrets (wrangler secret put):
//   PRIVATE_KEY             base64 32-byte RFC 8032 seed (prod signing key)
//   PADDLE_WEBHOOK_SECRET   Paddle Billing webhook signing secret
// KV namespaces:
//   CUSTOMERS  customer:<email>  -> { active, recurring, updatedAt }
//   SEATS      seats:<email>     -> [deviceId, ...]

import {
  b64decode,
  signToken,
  verifyPaddleWebhook,
  SEAT_LIMIT,
  PLAN,
  FEATURES,
  DAY_SECS,
} from "./lib.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Paddle-Signature",
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

function normalizeEmail(email) {
  return String(email || "")
    .toLowerCase()
    .trim();
}

async function readSeats(env, email) {
  const seats = JSON.parse((await env.SEATS.get(`seats:${email}`)) || "[]");
  return Array.isArray(seats) ? seats : [];
}

async function handleWebhook(request, env) {
  const raw = await request.text();
  const signature = request.headers.get("Paddle-Signature") || "";
  const valid = await verifyPaddleWebhook(
    env.PADDLE_WEBHOOK_SECRET,
    raw,
    signature,
  );
  if (!valid) return jsonError(401, "Invalid webhook signature");

  const event = JSON.parse(raw);
  const type = event.event_type || "";
  const data = event.data || {};
  const email = normalizeEmail(data.customer?.email);
  if (!email) return jsonOk({ ignored: true, reason: "no customer email" });

  const customerKey = `customer:${email}`;
  const current = JSON.parse((await env.CUSTOMERS.get(customerKey)) || "null");

  const recurringFromItems = (items) => {
    const price = Array.isArray(items)
      ? items.map((i) => i.price).find((p) => p?.billing_cycle?.interval)
      : null;
    return price ? price.billing_cycle.interval : null;
  };

  let next = current;
  if (type === "transaction.completed") {
    next = { active: true, recurring: recurringFromItems(data.items) ?? null };
  } else if (
    type === "subscription.activated" ||
    type === "subscription.updated"
  ) {
    next = { active: true, recurring: recurringFromItems(data.items) ?? null };
  } else if (
    type === "subscription.canceled" ||
    type === "subscription.past_due" ||
    type === "subscription.paused" ||
    type === "subscription.ended"
  ) {
    next = { active: false };
  }

  if (next) {
    next.updatedAt = nowSecs();
    await env.CUSTOMERS.put(customerKey, JSON.stringify(next));
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
