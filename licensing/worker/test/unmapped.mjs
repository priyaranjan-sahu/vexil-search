// Guards the difference between "we deliberately ignore this event" and
// "we act on this event but could not read it".
//
// The second case is the expensive one: a customer paid, the provider marks the
// event delivered, nothing retries, and no license is issued. That used to
// return an identical 200 to the harmless case, so it was invisible. Run inside
// the worker dir:  node test/unmapped.mjs

import { unmappedReason, PADDLE_HANDLED_TYPES } from "../src/lib.js";

let failures = 0;
function check(name, cond) {
  if (!cond) {
    console.error(`FAIL: ${name}`);
    failures += 1;
  } else {
    console.log(`ok: ${name}`);
  }
}

const paddle = (event_type, data) => ({ event_type, data: data ?? {} });

// The dangerous case: a type we subscribe to, with no readable email.
for (const t of PADDLE_HANDLED_TYPES) {
  check(
    `subscribed paddle event with no email is loud: ${t}`,
    unmappedReason(paddle(t), "paddle") === "unparsable_handled_event",
  );
}

// The harmless case: an event we never asked for.
for (const t of ["subscription.trial_started", "adjustment.created", ""]) {
  check(
    `unsubscribed paddle event is quiet: ${t || "(empty)"}`,
    unmappedReason(paddle(t), "paddle") === "unhandled_event_type",
  );
}

// Email present but blank/unusable still counts as unparsable.
check(
  "blank email on a subscribed event is loud",
  unmappedReason(
    paddle("transaction.completed", { customer: { email: "   " } }),
    "paddle",
  ) === "unparsable_handled_event",
);

// A completely absent data object must not throw.
check(
  "missing data object does not throw",
  unmappedReason({ event_type: "transaction.completed" }, "paddle") ===
    "unparsable_handled_event",
);
check(
  "missing event object does not throw",
  unmappedReason(undefined, "paddle") === "unhandled_event_type",
);

// BMAC: subscription events only count as handled when the feature is on.
check(
  "bmac purchase with no supporter_email is loud",
  unmappedReason(
    { type: "extra_purchase.created", data: {} },
    "buymeacoffee",
  ) === "unparsable_handled_event",
);
check(
  "bmac membership event is quiet when memberships disabled",
  unmappedReason({ type: "membership.started", data: {} }, "buymeacoffee") ===
    "unhandled_event_type",
);
check(
  "bmac membership event is loud when memberships enabled",
  unmappedReason({ type: "membership.started", data: {} }, "buymeacoffee", {
    supportMemberships: true,
  }) === "unparsable_handled_event",
);
check(
  "unknown bmac event is quiet",
  unmappedReason({ type: "donation.created", data: {} }, "buymeacoffee") ===
    "unhandled_event_type",
);

if (failures > 0) process.exit(1);
console.log(
  "PASS: unparsable vs deliberately-ignored events are distinguishable",
);
