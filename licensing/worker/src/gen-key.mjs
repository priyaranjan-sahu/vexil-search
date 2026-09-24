// Generates a production Ed25519 keypair for license signing.
//
// Usage: node src/gen-key.mjs <output-dir>
//
// - writes <dir>/vexil_public.key  (base64 public key — put this in the app
//   build as VEXIL_PUBLIC_KEY / commit-worthy)
// - prints  PRIVATE_KEY=<base64 seed>  exactly once. Store it in a password
//   manager AND as the Worker secret:  wrangler secret put PRIVATE_KEY
//
// Seed/derivation is RFC 8032, byte-identical to Rust's ed25519-dalek and the
// existing sign_license CLI, so all three can interoperate.

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: node src/gen-key.mjs <output-dir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const seed = randomBytes(32);
const publicKey = ed25519.getPublicKey(seed);

const publicB64 = Buffer.from(publicKey).toString("base64");
const privateB64 = Buffer.from(seed).toString("base64");

writeFileSync(join(outDir, "vexil_public.key"), publicB64 + "\n");
console.log(`wrote ${join(outDir, "vexil_public.key")}`);
console.log("");
console.log("PRIVATE_KEY (base64 RFC 8032 seed) — record it now; shown once:");
console.log(privateB64);
console.log("");
console.log("Next: wrangler secret put PRIVATE_KEY   (paste the line above)");
