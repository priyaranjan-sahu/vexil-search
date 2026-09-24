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

// Length of a PVO-pricing subscription term in days (monthly / yearly / one-time).
export function intervalDays(interval) {
  if (interval === "year") return 365;
  return 30; // "month" or anything else -> a safe default term
}
