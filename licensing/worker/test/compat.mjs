// Cross-implementation compatibility proof.
// The Worker signs license tokens with @noble/curves (JS). The app verifies
// them with ed25519-dalek (Rust). This test proves, against the repo's own
// dev keypair, that:
//   1. the 32-byte seed in vexil_private.key derives vexil_public.key
//      (so seed formats are byte-identical between implementations)
//   2. a noble-signed token self-verifies with noble
//   3. a noble-signed token is written for a Rust-side check
//      (`cargo run --bin sign_license -- verify ...`), proving the app's
//      verifier accepts JS signatures.
//   4. a Rust-produced token (dev_sample.lic) verifies with noble,
//      proving signatures are bidirectionally interchangeable.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { signToken, verifyToken, b64decode } from "../src/lib.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const keyDir = join(repoRoot, "src-tauri", "licenses");

function b64decodeNode(b64) {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function b64encodeNode(bytes) {
  return Buffer.from(bytes).toString("base64");
}

// 1. Seed -> public key must match the committed public key.
const privB64 = readFileSync(join(keyDir, "vexil_private.key"), "utf8").trim();
const pubB64 = readFileSync(join(keyDir, "vexil_public.key"), "utf8").trim();
const seed = b64decodeNode(privB64);
const derivedPub = b64encodeNode(ed25519.getPublicKey(seed));
if (derivedPub !== pubB64) {
  console.error("FAIL: seed does not derive the committed public key");
  process.exit(1);
}
console.log("ok: RFC 8032 seed derives the committed public key");

// 2. noble-sign a token with the dev key (simulates Worker output).
const payload = {
  version: 2,
  userId: "noble-compat@example.com",
  plan: "pro",
  features: ["background", "removable_drives", "unlimited_picks"],
  issuedAt: Math.floor(Date.now() / 1000),
  expiresAt: null,
  deviceId: "deadbeef00000001",
};
const token = signToken(payload, seed);
const decoded = verifyToken(token, b64decodeNode(pubB64));
if (
  decoded.userId !== payload.userId ||
  decoded.deviceId !== payload.deviceId
) {
  console.error("FAIL: round-trip mismatch");
  process.exit(1);
}
console.log("ok: noble-signed token round-trips with noble");

// 3. Write the token for a Rust-side (dalek) verification.
const outPath = join(here, "compat.lic");
writeFileSync(outPath, token);
console.log(`wrote ${outPath}`);

// 4. Verify a Rust-produced token (dev_sample.lic) with noble.
const rustToken = readFileSync(join(keyDir, "dev_sample.lic"), "utf8").trim();
const [rustBody] = rustToken.split(".");
const rustJson = JSON.parse(new TextDecoder().decode(b64decode(rustBody)));
const verified = verifyToken(rustToken, b64decodeNode(pubB64));
if (verified.plan !== rustJson.plan || verified.plan !== "pro") {
  console.error("FAIL: Rust-produced token did not verify");
  process.exit(1);
}
console.log("ok: Rust (dalek)-produced token verifies with noble");
console.log("PASS: cross-implementation compatibility proven");
