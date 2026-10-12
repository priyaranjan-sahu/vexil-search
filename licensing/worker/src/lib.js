// Pure, environment-agnostic licensing helpers used by the Worker.
// Uses only standards available in both Cloudflare Workers and Node:
// TextEncoder, btoa, atob, WebCrypto. PB stands for "payload bytes" length.

import { ed25519 } from "@noble/curves/ed25519";

export const SEAT_LIMIT = 3;
export const PLAN = "pro";
export const FEATURES = ["background", "removable_drives", "unlimited_picks"];
export const CURRENT_VERSION = 2;
export const DAY_SECS = 86_400;

export function b64encode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64decode(b64) {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// RFC 8032 Ed25519 sign token matching Vexil's Rust verifier:
//   base64(json).base64(sig)   (standard base64 with padding)
// secretKey must be the 32-byte RFC 8032 seed — byte-identical to the Rust
// `ed25519_dalek::SigningKey::to_bytes()` and the `sign_license` CLI output.
export function signToken(payload, secretKeyBytes) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const sig = ed25519.sign(body, secretKeyBytes);
  return `${b64encode(body)}.${b64encode(sig)}`;
}

export function verifyToken(token, publicKeyBytes) {
  const [payloadB64, sigB64] = token.split(".");
  if (!payloadB64 || !sigB64) throw new Error("malformed token");
  const body = b64decode(payloadB64);
  const sig = b64decode(sigB64);
  const ok = ed25519.verify(sig, body, publicKeyBytes);
  if (!ok) throw new Error("signature verification failed");
  return JSON.parse(new TextDecoder().decode(body));
}

export function normalizeEmail(email) {
  return String(email || "")
    .toLowerCase()
    .trim();
}

// Length-independent, value-independent comparison for short secrets (hex
// digests, device tokens). `a === b` short-circuits on the first differing
// byte, which leaks position information through timing to anyone who can
// measure it. This walks the full length regardless.
export function constantTimeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) {
    diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  }
  return diff === 0;
}

// Fixed-window rate limiter backed by KV.
//
// The counter is per (key, window) and TTL'd, so it self-cleans without a cron.
// It is not perfectly atomic under concurrency (a burst can read the same
// count twice), but it is enough to stop the abuse this exists for: scraping
// `/activate` to enumerate paying emails, or filling a victim's device seats
// from a script. Returns `true` when the caller is over budget.
export async function isRateLimited(kv, key, limit, windowSecs) {
  const bucket = Math.floor(Date.now() / 1000 / windowSecs);
  const bucketKey = `rl:${key}:${bucket}`;
  const current = Number((await kv.get(bucketKey)) || "0");
  if (current >= limit) return true;
  await kv.put(bucketKey, String(current + 1), {
    expirationTtl: windowSecs * 2,
  });
  return false;
}

// Paddle Billing webhook verification.
// Header `Paddle-Signature: ts=<ts>;h1=<hex>` where the HMAC-SHA256 of the
// message `<ts>:<rawBody>` (hex-encoded HMAC) equals h1.
//
// The timestamp is also checked for freshness. Without that, a captured
// delivery replays forever (the HMAC of an old body stays valid), which for a
// licensing webhook means a refund or cancellation can be undone by replaying
// the earlier "active" event. Paddle's own SDKs default to a 5-minute window.
export const PADDLE_MAX_SKEW_SECS = 300;

export async function verifyPaddleWebhook(
  secret,
  rawBody,
  signatureHeader,
  {
    now = Math.floor(Date.now() / 1000),
    maxSkewSecs = PADDLE_MAX_SKEW_SECS,
  } = {},
) {
  if (!signatureHeader) return false;
  const ts = signatureHeader.match(/ts=(\d+)/)?.[1];
  const h1 = signatureHeader.match(/h1=([0-9a-f]+)/)?.[1];
  if (!ts || !h1) return false;
  const message = `${ts}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  const hex = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (!constantTimeEqual(hex, h1)) return false;
  return Math.abs(now - Number(ts)) <= maxSkewSecs;
}

// Buy Me a Coffee webhook verification.
// Header `x-signature-sha256: <hex>` where the value is the hex HMAC-SHA256
// of the raw request body keyed with the webhook's per-webhook signing
// secret. An `x-bmc-signature` fallback is accepted by the caller.
// Both digests are fixed-length lowercase hex (64 chars for SHA-256), so a
// length-gated `===` behaves like a constant-time compare (Paddle precedent).
export async function verifyBmcWebhook(secret, rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody),
  );
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return constantTimeEqual(expected, signatureHeader.trim().toLowerCase());
}

// Maps a Paddle Billing webhook event to a customer-record update.
// Returns { email, active, recurring } or null when nothing changed.
export function paddleEventState(event) {
  const type = event.event_type || "";
  const data = event.data || {};
  const email = normalizeEmail(data.customer?.email);
  if (!email) return null;

  const items = event.data?.items;
  const price = Array.isArray(items)
    ? items.map((i) => i.price).find((p) => p?.billing_cycle?.interval)
    : null;
  const recurring = price ? price.billing_cycle.interval : null;

  if (
    type === "transaction.completed" ||
    type === "subscription.activated" ||
    type === "subscription.updated"
  ) {
    return { email, active: true, recurring };
  }
  if (
    type === "subscription.canceled" ||
    type === "subscription.past_due" ||
    type === "subscription.paused" ||
    type === "subscription.ended"
  ) {
    return { email, active: false };
  }
  return null;
}

// The Paddle event types this worker subscribes to and acts on. Kept separate
// from paddleEventState so index.js can tell "we deliberately ignore this
// event" apart from "we act on this event but could not read it".
export const PADDLE_HANDLED_TYPES = Object.freeze([
  "transaction.completed",
  "subscription.activated",
  "subscription.updated",
  "subscription.canceled",
  "subscription.past_due",
  "subscription.paused",
  "subscription.ended",
]);

// Why an event produced no licensing change, or null when it did change state
// and the caller should apply it.
//
// The distinction matters. An event type we never subscribed to is expected and
// needs no attention. An event type we DO act on, but whose payload we could
// not read, means a customer paid and is owed a license: the provider marks it
// delivered, nothing retries, and without this distinction that is silent.
export function unmappedReason(event, provider, opts = {}) {
  if (provider === "paddle") {
    return PADDLE_HANDLED_TYPES.includes(event?.event_type || "")
      ? "unparsable_handled_event"
      : "unhandled_event_type";
  }
  const type = event?.type || "";
  const handled =
    type === "extra_purchase.created" ||
    type === "extra_purchase.refunded" ||
    (opts.supportMemberships === true && type.startsWith("membership."));
  return handled ? "unparsable_handled_event" : "unhandled_event_type";
}

// Parses a comma-separated list of product id/title matchers into entries.
export function parseBmcProductSpec(spec) {
  return String(spec || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// True when one of the purchased `extras` items matches the product spec.
// Matches against the item's numeric id OR its title (case-insensitive).
export function bmcMatchesProduct(data, productSpec) {
  const entries = parseBmcProductSpec(productSpec);
  if (entries.length === 0) return false; // fail closed: nothing can grant Pro
  const items = Array.isArray(data?.extras) ? data.extras : [];
  return items.some((item) => {
    const idMatch = entries.includes(String(item.id));
    const titleMatch = entries.some(
      (e) => String(item.title || "").toLowerCase() === e.toLowerCase(),
    );
    return idMatch || titleMatch;
  });
}

// Maps a Buy Me a Coffee webhook event to a customer-record update.
// Only configured `extra_purchase` events grant/revoke Pro; donations and
// other events return null and are ignored. Memberships are only honored
// when opts.supportMemberships is true.
// Returns { email, active, recurring } or null when ignored.
export function bmcEventState(event, opts = {}) {
  const type = event.type || "";
  const data = event.data || {};
  const email = normalizeEmail(data.supporter_email);
  if (!email) return null;

  const productSpec = parseBmcProductSpec(opts.proProductId);

  if (type === "extra_purchase.created") {
    if (!bmcMatchesProduct(data, productSpec)) return null;
    return { email, active: true, recurring: null };
  }
  if (type === "extra_purchase.refunded") {
    if (!bmcMatchesProduct(data, productSpec)) return null;
    return { email, active: false };
  }

  if (opts.supportMemberships === true && type.startsWith("membership.")) {
    const recurring = data.duration_type === "year" ? "year" : "month";
    if (type === "membership.started" || type === "membership.updated") {
      return data.status === "active"
        ? { email, active: true, recurring }
        : { email, active: false };
    }
    if (type === "membership.cancelled" || type === "membership.paused") {
      return { email, active: false };
    }
  }
  return null;
}

// Length of a PVO-pricing subscription term in days (monthly / yearly / one-time).
export function intervalDays(interval) {
  if (interval === "year") return 365;
  return 30; // "month" or anything else -> a safe default term
}
