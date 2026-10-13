// Vexil license issuance worker.
//
// - POST /webhook           Paddle Billing and Buy Me a Coffee webhook receiver
//                           (verified via HMAC; provider auto-detected or pinned).
// - POST /activate/request  `{ email }` -> emails a 6-digit activation code.
// - POST /activate          `{ email, deviceId, code }` -> signed `.lic` token.
// - POST /verify            `{ email, deviceId }` -> `{ active }` (no side effects).
// - POST /deactivate        `{ email, deviceId }` -> frees a device seat.
// - GET  /health            liveness.
//
// Secrets (wrangler secret put):
//   PRIVATE_KEY             base64 32-byte RFC 8032 seed (prod signing key)
//   PADDLE_WEBHOOK_SECRET   Paddle Billing webhook signing secret
//   BMAC_WEBHOOK_SECRET     Buy Me a Coffee webhook signing secret
//   RESEND_API_KEY          Resend API key, for emails sent by /activate/request
// [vars]:
//   WEBHOOK_PROVIDER        "paddle" | "buymeacoffee" | "auto" (default "auto")
//   PADDLE_PRO_PRODUCT_ID   price/product id or name (comma-separated) that
//                           grants a Pro license via Paddle; fail-closed when empty
//   BMAC_PRO_PRODUCT_ID     shop item id or title (comma-separated) that grants
//                           a Pro license; fail-closed when empty
//   BMAC_SUPPORT_MEMBERSHIPS "true" to also map active memberships to Pro
//   EMAIL_FROM              From: address for activation emails (Resend)
//   ALLOWED_ORIGINS         comma-separated browser origins allowed by CORS;
//                           unset means no cross-origin access at all
// KV namespaces:
//   CUSTOMERS  customer:<email>      -> { active, recurring, updatedAt }
//              hook:<provider>:<id>  -> dedupe marker (30-day TTL)
//   SEATS      seats:<email>         -> legacy seat list, read once into the
//                                       Durable Object (see gate.js)
// Durable Objects:
//   GATE       one object per (seat:<email> | rl:<key> | code:<email>)

import {
  b64decode,
  signToken,
  normalizeEmail,
  verifyPaddleWebhook,
  verifyBmcWebhook,
  paddleEventState,
  bmcEventState,
  unmappedReason,
  SEAT_LIMIT,
  PLAN,
  FEATURES,
  DAY_SECS,
  EMAIL_CODE_TTL_SECS,
  generateEmailCode,
} from "./lib.js";

export { LicenseGate } from "./gate.js";

// Per-window request budgets. Generous enough for a shared/NAT'd network, tight
// enough that a script cannot enumerate emails or burn through a victim's three
// device seats in seconds.
const ACTIVATE_PER_IP = 20; // per minute
const ACTIVATE_PER_EMAIL = 3; // per minute; never above SEAT_LIMIT
// Requesting a code is a separate budget from spending it: a request only sends
// an email (no seat), so charging it against the activation budget would let the
// two-step flow exhaust the three activation attempts before a device is set up.
const ACTIVATE_REQ_PER_IP = 20; // per minute
const ACTIVATE_REQ_PER_EMAIL = 5; // per minute; caps outbound activation emails
const VERIFY_PER_IP = 30; // per minute
const DEACTIVATE_PER_IP = 20; // per minute
const RATE_WINDOW_SECS = 60;

function corsHeaders(env, request) {
  const origin = request.headers.get("Origin");
  if (!origin) return {};
  const allowed = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Paddle-Signature, x-signature-sha256, x-bmc-signature",
    Vary: "Origin",
  };
}

function jsonOk(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

// --- Durable Object helpers -------------------------------------------------

function gateStub(env, name) {
  return env.GATE.get(env.GATE.idFromName(name));
}

async function gateCall(env, name, payload) {
  const res = await gateStub(env, name).fetch("https://gate.internal/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

/** Atomic fixed-window rate limit backed by a per-key Durable Object. */
async function isLimited(env, key, limit, windowSecs) {
  const { limited } = await gateCall(env, `rl:${key}`, {
    op: "rate",
    limit,
    windowSecs,
  });
  return limited === true;
}

// Legacy KV seat list, read only to seed the Durable Object on first use.
async function readLegacySeats(env, email) {
  const seats = JSON.parse((await env.SEATS.get(`seats:${email}`)) || "[]");
  return Array.isArray(seats) ? seats : [];
}

async function gateSeats(env, email) {
  const legacy = await readLegacySeats(env, email);
  return gateCall(env, `seat:${email}`, {
    op: "seedSeats",
    seats: legacy,
    limit: SEAT_LIMIT,
  });
}

async function sendActivationCode(env, email, code) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: email,
      subject: "Your Vexil activation code",
      text:
        `Your Vexil activation code is ${code}. ` +
        `It expires in ${Math.round(EMAIL_CODE_TTL_SECS / 60)} minutes. ` +
        `If you did not request this, you can ignore this email.`,
    }),
  });
  return res.ok;
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
      ? paddleEventState(event, { proProductId: env.PADDLE_PRO_PRODUCT_ID })
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
      paddleProProductId: env.PADDLE_PRO_PRODUCT_ID,
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

// Step 1 of activation: prove the caller can read the paid email's inbox.
async function handleActivateRequest(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonError(400, "Invalid JSON body");
  const email = normalizeEmail(body.email);
  if (!email) return jsonError(400, "email is required");

  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    return jsonError(
      503,
      "Email verification is not configured on this server; use an offline activation key.",
    );
  }

  const ip = clientIp(request);
  if (
    (await isLimited(
      env,
      `activate-req:ip:${ip}`,
      ACTIVATE_REQ_PER_IP,
      RATE_WINDOW_SECS,
    )) ||
    (await isLimited(
      env,
      `activate-req:email:${email}`,
      ACTIVATE_REQ_PER_EMAIL,
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

  const code = generateEmailCode();
  await gateCall(env, `code:${email}`, {
    op: "putCode",
    code,
    expiresAt: nowSecs() + EMAIL_CODE_TTL_SECS,
  });
  const sent = await sendActivationCode(env, email, code);
  if (!sent)
    return jsonError(502, "Could not send the code; try again shortly");
  return jsonOk({ sent: true });
}

async function handleActivate(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonError(400, "Invalid JSON body");
  const email = normalizeEmail(body.email);
  const deviceId = String(body.deviceId || "").trim();
  const code = String(body.code || "").trim();
  if (!email || !deviceId)
    return jsonError(400, "email and deviceId are required");
  if (!/^[0-9a-f]{16}$/.test(deviceId)) {
    return jsonError(400, "invalid deviceId (expected 16 hex chars)");
  }

  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    return jsonError(
      503,
      "Email verification is not configured on this server; use an offline activation key.",
    );
  }
  if (!/^\d{6}$/.test(code)) {
    return jsonError(
      400,
      "a 6-digit code is required; request one with POST /activate/request",
    );
  }

  // `/activate` is unauthenticated apart from the emailed code. Rate limiting
  // is the outer wall; the per-email code check is what actually proves the
  // caller controls the paid inbox.
  const ip = clientIp(request);
  if (
    (await isLimited(
      env,
      `activate:ip:${ip}`,
      ACTIVATE_PER_IP,
      RATE_WINDOW_SECS,
    )) ||
    (await isLimited(
      env,
      `activate:email:${email}`,
      ACTIVATE_PER_EMAIL,
      RATE_WINDOW_SECS,
    ))
  ) {
    return jsonError(429, "Too many activation attempts; try again shortly");
  }

  const check = await gateCall(env, `code:${email}`, {
    op: "checkCode",
    code,
    now: nowSecs(),
  });
  if (check.status !== "ok") {
    return jsonError(403, "Invalid or expired activation code");
  }

  const customer = JSON.parse(
    (await env.CUSTOMERS.get(`customer:${email}`)) || "null",
  );
  if (!customer?.active) {
    return jsonError(403, "No active license found for this email");
  }

  const seatResult = await gateCall(env, `seat:${email}`, {
    op: "addSeat",
    deviceId,
    limit: SEAT_LIMIT,
  });
  if (!seatResult.ok) {
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
    await isLimited(env, `verify:ip:${ip}`, VERIFY_PER_IP, RATE_WINDOW_SECS)
  ) {
    return jsonError(429, "Too many requests; try again shortly");
  }

  const customer = JSON.parse(
    (await env.CUSTOMERS.get(`customer:${email}`)) || "null",
  );
  const { seats } = await gateSeats(env, email);
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
    await isLimited(
      env,
      `deactivate:ip:${ip}`,
      DEACTIVATE_PER_IP,
      RATE_WINDOW_SECS,
    )
  ) {
    return jsonError(429, "Too many requests; try again shortly");
  }

  // Seed from KV first so a legacy seat isn't missed by the removal.
  await gateSeats(env, email);
  const { removed } = await gateCall(env, `seat:${email}`, {
    op: "removeSeat",
    deviceId,
  });
  return jsonOk({ removed });
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    let response;
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health") response = jsonOk({ status: "ok" });
      else if (url.pathname === "/webhook" && request.method === "POST")
        response = await handleWebhook(request, env);
      else if (
        url.pathname === "/activate/request" &&
        request.method === "POST"
      )
        response = await handleActivateRequest(request, env);
      else if (url.pathname === "/activate" && request.method === "POST")
        response = await handleActivate(request, env);
      else if (url.pathname === "/verify" && request.method === "POST")
        response = await handleVerify(request, env);
      else if (url.pathname === "/deactivate" && request.method === "POST")
        response = await handleDeactivate(request, env);
      else response = jsonError(404, "Not found");
    } catch (err) {
      console.error("worker error:", err);
      response = jsonError(500, "Internal error");
    }

    for (const [key, value] of Object.entries(cors)) {
      response.headers.set(key, value);
    }
    return response;
  },
};
