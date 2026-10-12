// Vexil license issuance worker.
//
// - POST /webhook    Paddle Billing and Buy Me a Coffee webhook receiver
//                    (verified via HMAC; provider auto-detected or pinned).
// - POST /activate   `{ email, deviceId }` -> signed `.lic` token (device-bound).
// - POST /verify     `{ email, deviceId }` -> `{ active }` (no side effects).
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
  unmappedReason,
  isRateLimited,
  SEAT_LIMIT,
  PLAN,
  FEATURES,
  DAY_SECS,
} from "./lib.js";

// Per-window request budgets. Generous enough for a shared/NAT'd network, tight
// enough that a script cannot enumerate emails or burn through a victim's three
// device seats in seconds.
const ACTIVATE_PER_IP = 20; // per minute
const ACTIVATE_PER_EMAIL = 5; // per minute
const VERIFY_PER_IP = 30; // per minute
const DEACTIVATE_PER_IP = 20; // per minute
const RATE_WINDOW_SECS = 60;

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

/** Best-effort client identity for rate limiting (Workers sets this header). */
function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("x-forwarded-for") ||
    "unknown"
  );
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
    // Returning 200 here is deliberate: a non-2xx would make Paddle retry a
    // payload that will never parse, burning its retry budget and then
    // dropping the event anyway. So we stay 200 and make the failure loud
    // instead of silent.
    const reason = unmappedReason(event, provider, {
      proProductId: env.BMAC_PRO_PRODUCT_ID,
      supportMemberships: env.BMAC_SUPPORT_MEMBERSHIPS === "true",
    });
    if (reason === "unparsable_handled_event") {
      // Loud on purpose: this is an event we subscribed to and understand, so
      // failing to read it means a customer paid and got nothing. Surfaced via
      // console.error so it shows in `wrangler tail` and Workers Logs.
      console.error(
        JSON.stringify({
          alert: "unparsable_licensing_event",
          provider,
          event_type: type,
          event_id: eventId || null,
          reason:
            "a subscribed event type arrived but no customer email could be read from it; " +
            "the customer paid and will NOT be granted a license",
          data_keys: Object.keys(event.data || {}),
        }),
      );
    }
    return jsonOk({
      received: true,
      ignored: true,
      ignored_reason: reason,
      type,
    });
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

  // `/activate` is unauthenticated by design — the payment webhook is the thing
  // that vests the email with an active record. Rate limiting is what stops a
  // script from probing emails to learn who has paid, or from claiming all of a
  // victim's device seats with made-up device ids.
  const ip = clientIp(request);
  if (
    (await isRateLimited(
      env.CUSTOMERS,
      `activate:ip:${ip}`,
      ACTIVATE_PER_IP,
      RATE_WINDOW_SECS,
    )) ||
    (await isRateLimited(
      env.CUSTOMERS,
      `activate:email:${email}`,
      ACTIVATE_PER_EMAIL,
      RATE_WINDOW_SECS,
    ))
  ) {
    return jsonError(429, "Too many activation attempts; try again shortly");
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
    // Marks a server-issued token the client will re-check against `/verify`
    // on startup, so a refunded/canceled license can be revoked even when the
    // token itself has no expiry (one-time purchases). Offline keys omit this
    // and are never revocation-checked.
    renewable: true,
  };
  const privateKey = b64decode(env.PRIVATE_KEY);
  const license = signToken(payload, privateKey);

  if (!exists) {
    seats.push(deviceId);
    await env.SEATS.put(`seats:${email}`, JSON.stringify(seats));
  }
  return jsonOk({ license });
}

async function handleVerify(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonError(400, "Invalid JSON body");
  const email = normalizeEmail(body.email);
  const deviceId = String(body.deviceId || "").trim();
  if (!email || !deviceId) {
    return jsonError(400, "email and deviceId are required");
  }

  const ip = clientIp(request);
  if (
    await isRateLimited(
      env.CUSTOMERS,
      `verify:ip:${ip}`,
      VERIFY_PER_IP,
      RATE_WINDOW_SECS,
    )
  ) {
    return jsonError(429, "Too many requests; try again shortly");
  }

  const customer = JSON.parse(
    (await env.CUSTOMERS.get(`customer:${email}`)) || "null",
  );
  const seats = await readSeats(env, email);
  const active = Boolean(customer?.active) && seats.includes(deviceId);
  // Always 200 for a well-formed request: the client must be able to tell a
  // definite "no longer active" apart from a transport/HTTP failure, and only
  // drop a local license on the former.
  return jsonOk({ active });
}

async function handleDeactivate(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonError(400, "Invalid JSON body");
  const email = normalizeEmail(body.email);
  const deviceId = String(body.deviceId || "").trim();
  if (!email || !deviceId) {
    return jsonError(400, "email and deviceId are required");
  }

  // Unauthenticated state mutation, so it is rate limited like `/activate`.
  // Without a budget an attacker could strip a victim's registered devices.
  const ip = clientIp(request);
  if (
    await isRateLimited(
      env.CUSTOMERS,
      `deactivate:ip:${ip}`,
      DEACTIVATE_PER_IP,
      RATE_WINDOW_SECS,
    )
  ) {
    return jsonError(429, "Too many requests; try again shortly");
  }

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
      if (url.pathname === "/verify" && request.method === "POST") {
        return handleVerify(request, env);
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
