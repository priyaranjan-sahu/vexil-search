// Verifies the constant-time comparison the worker relies on for activation
// codes and webhook signatures. (Rate limiting is covered by test/gate.mjs.)
// Run inside the worker dir:  node test/security.mjs

import { constantTimeEqual } from "../src/lib.js";

let failures = 0;
function check(name, cond) {
  if (!cond) {
    console.error(`FAIL: ${name}`);
    failures += 1;
  } else {
    console.log(`ok: ${name}`);
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

if (failures > 0) process.exit(1);
console.log("PASS: security helpers");
