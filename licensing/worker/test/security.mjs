// Verifies the security helpers the worker relies on for `/activate` and
// `/deactivate`: constant-time comparison and the KV-backed rate limiter.
// Run inside the worker dir:  node test/security.mjs

import { constantTimeEqual, isRateLimited } from "../src/lib.js";

let failures = 0;
function check(name, cond) {
  if (!cond) {
    console.error(`FAIL: ${name}`);
    failures += 1;
  } else {
    console.log(`ok: ${name}`);
  }
}

// Minimal in-memory stand-in for a Workers KV namespace.
class FakeKV {
  constructor() {
    this.map = new Map();
  }
  async get(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  async put(key, value) {
    this.map.set(key, value);
  }
}

// --- constantTimeEqual ---
check("equal strings match", constantTimeEqual("abcdef", "abcdef") === true);
check(
  "differing strings differ",
  constantTimeEqual("abcdef", "abcxef") === false,
);
check("length mismatch differs", constantTimeEqual("abc", "abcd") === false);
check("empty matches empty", constantTimeEqual("", "") === true);

// --- isRateLimited ---
const kv = new FakeKV();
const key = "activate:ip:1.2.3.4";
const results = [];
for (let i = 0; i < 4; i += 1) {
  results.push(await isRateLimited(kv, key, 3, 60));
}
check(
  "first three under budget",
  results.slice(0, 3).every((r) => r === false),
);
check("fourth is limited", results[3] === true);

// A different key has its own budget.
check(
  "other keys are independent",
  (await isRateLimited(kv, "activate:ip:5.6.7.8", 3, 60)) === false,
);

// A tiny window lets the budget reset.
const kv2 = new FakeKV();
await isRateLimited(kv2, key, 1, 1);
await new Promise((r) => setTimeout(r, 1100));
check(
  "budget resets after the window",
  (await isRateLimited(kv2, key, 1, 1)) === false,
);

if (failures > 0) process.exit(1);
console.log("PASS: security helpers");
