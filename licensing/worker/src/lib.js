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

// Paddle Billing webhook verification.
// Header `Paddle-Signature: ts=<ts>;h1=<hex>` where the HMAC-SHA256 of the
// message `<ts>:<rawBody>` (hex-encoded HMAC) equals h1.
export async function verifyPaddleWebhook(secret, rawBody, signatureHeader) {
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
  return hex === h1;
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
  return expected === signatureHeader.trim().toLowerCase();
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
