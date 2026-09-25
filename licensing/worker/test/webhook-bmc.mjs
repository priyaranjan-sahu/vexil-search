// Verifies Buy Me a Coffee webhook verification and event-to-customer
// mapping, mirroring the official webhook contract:
//   x-signature-sha256: <hex HMAC-SHA256 of the raw body, keyed with the
//                       per-webhook signing secret>
//   envelope:           { event_id, type, live_mode, created, attempt, data }
// Run inside the worker dir:  node test/webhook-bmc.mjs

import { createHmac } from "node:crypto";
import {
  verifyBmcWebhook,
  bmcEventState,
  bmcMatchesProduct,
} from "../src/lib.js";

const secret = "bmc-webhook-secret";

function sign(body) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function envelope(type, data, eventId = 420000) {
  return JSON.stringify({
    event_id: eventId,
    type,
    live_mode: true,
    created: 1719825600,
    attempt: 1,
    data,
  });
}

const proItem = {
  id: 555,
  object: "extra",
  title: "Vexil Pro License",
  description: "Lifetime Pro license",
  amount: 20.0,
  quantity: 1,
  currency: "USD",
};
const otherItem = { ...proItem, id: 999, title: "Stickers" };

const extraData = (items, overrides = {}) => ({
  id: 98765,
  object: "payment",
  transaction_id: "pi_3QxxxxxYyyyyy",
  status: "succeeded",
  refunded: "false",
  amount: 20.0,
  currency: "USD",
  supporter_email: "Buyer@Example.com",
  support_type: "Extra",
  created_at: 1719825600,
  refunded_at: null,
  extras: items,
  ...overrides,
});

let failures = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    console.error(`FAIL: ${name}\n  actual:   ${a}\n  expected: ${b}`);
    failures += 1;
  } else {
    console.log(`ok: ${name}`);
  }
}

// --- Signature verification -------------------------------------------------

const body = envelope("donation.created", { supporter_email: "a@b.co" });
const sig = sign(body);

eq("valid signature accepted", await verifyBmcWebhook(secret, body, sig), true);
eq(
  "wrong secret rejected",
  await verifyBmcWebhook("wrong-secret", body, sig),
  false,
);
eq(
  "tampered body rejected",
  await verifyBmcWebhook(secret, body.replace("donation", "beer "), sig),
  false,
);
eq(
  "missing signature rejected",
  await verifyBmcWebhook(secret, body, ""),
  false,
);
eq(
  "uppercase hex signature accepted",
  await verifyBmcWebhook(secret, body, sig.toUpperCase()),
  true,
);
eq(
  "garbage signature rejected",
  await verifyBmcWebhook(secret, body, "not-hex"),
  false,
);

// --- Product matching -------------------------------------------------------

eq(
  "matches by numeric id",
  bmcMatchesProduct(extraData([proItem]), "555"),
  true,
);
eq(
  "matches by title case-insensitively",
  bmcMatchesProduct(extraData([proItem]), "vexil pro license"),
  true,
);
eq(
  "matches second entry in list",
  bmcMatchesProduct(extraData([proItem]), "Stickers, 555"),
  true,
);
eq(
  "rejects non-matching item",
  bmcMatchesProduct(extraData([otherItem]), "555"),
  false,
);
eq(
  "fails closed on empty spec",
  bmcMatchesProduct(extraData([proItem]), ""),
  false,
);
eq("fails closed on missing extras", bmcMatchesProduct({}, "555"), false);

// --- Event mapping ----------------------------------------------------------

eq(
  "extra purchase grants Pro",
  bmcEventState(
    JSON.parse(envelope("extra_purchase.created", extraData([proItem]))),
    {
      proProductId: "555",
    },
  ),
  { email: "buyer@example.com", active: true, recurring: null },
);

eq(
  "non-matching extra purchase ignored",
  bmcEventState(
    JSON.parse(envelope("extra_purchase.created", extraData([otherItem]))),
    {
      proProductId: "555",
    },
  ),
  null,
);

eq(
  "extra purchase ignored when product unconfigured",
  bmcEventState(
    JSON.parse(envelope("extra_purchase.created", extraData([proItem]))),
    {
      proProductId: "",
    },
  ),
  null,
);

eq(
  "extra purchase refund revokes Pro",
  bmcEventState(
    JSON.parse(envelope("extra_purchase.refunded", extraData([proItem]))),
    {
      proProductId: "555",
    },
  ),
  { email: "buyer@example.com", active: false },
);

eq(
  "donation ignored even with supporter email",
  bmcEventState(
    JSON.parse(
      envelope("donation.created", { supporter_email: "buyer@example.com" }),
    ),
    { proProductId: "555" },
  ),
  null,
);

eq(
  "membership disabled by default",
  bmcEventState(
    JSON.parse(
      envelope("membership.started", {
        supporter_email: "buyer@example.com",
        status: "active",
        duration_type: "month",
        amount: 5.0,
      }),
    ),
    { proProductId: "555", supportMemberships: false },
  ),
  null,
);

eq(
  "active monthly membership grants Pro",
  bmcEventState(
    JSON.parse(
      envelope("membership.started", {
        supporter_email: "buyer@example.com",
        status: "active",
        duration_type: "month",
        amount: 5.0,
      }),
    ),
    { proProductId: "555", supportMemberships: true },
  ),
  { email: "buyer@example.com", active: true, recurring: "month" },
);

eq(
  "yearly membership maps to recurring year",
  bmcEventState(
    JSON.parse(
      envelope("membership.updated", {
        supporter_email: "buyer@example.com",
        status: "active",
        duration_type: "year",
      }),
    ),
    { proProductId: "555", supportMemberships: true },
  ),
  { email: "buyer@example.com", active: true, recurring: "year" },
);

eq(
  "membership cancellation revokes Pro",
  bmcEventState(
    JSON.parse(
      envelope("membership.cancelled", {
        supporter_email: "buyer@example.com",
        status: "canceled",
        duration_type: "month",
      }),
    ),
    { proProductId: "555", supportMemberships: true },
  ),
  { email: "buyer@example.com", active: false },
);

eq(
  "membership update to canceled revokes Pro",
  bmcEventState(
    JSON.parse(
      envelope("membership.updated", {
        supporter_email: "buyer@example.com",
        status: "canceled",
        duration_type: "month",
      }),
    ),
    { proProductId: "555", supportMemberships: true },
  ),
  { email: "buyer@example.com", active: false },
);

eq(
  "recurring donation ignored",
  bmcEventState(
    JSON.parse(
      envelope("recurring_donation.started", {
        supporter_email: "buyer@example.com",
        monthly_amount: 3.0,
      }),
    ),
    { proProductId: "555", supportMemberships: true },
  ),
  null,
);

const extraNoEmail = JSON.parse(
  envelope("extra_purchase.created", {
    id: 1,
    object: "payment",
    extras: [proItem],
  }),
);
eq(
  "extra purchase without supporter email ignored",
  bmcEventState(extraNoEmail, {
    proProductId: "555",
  }),
  null,
);

if (failures > 0) process.exit(1);
console.log("PASS: BMAC webhook verification and mapping");
