// Unit tests for the LicenseGate Durable Object. The object is single-threaded
// in production; these tests drive it directly with a fake storage so the seat
// limit, the rate limiter and the activation-code budget are all exercised
// without deploying. Run inside the worker dir:  node test/gate.mjs

import { LicenseGate } from "../src/gate.js";

let failures = 0;
function check(name, cond) {
  if (!cond) {
    console.error(`FAIL: ${name}`);
    failures += 1;
  } else {
    console.log(`ok: ${name}`);
  }
}

class FakeStorage {
  constructor() {
    this.map = new Map();
  }
  async get(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  async put(key, value) {
    this.map.set(key, value);
  }
  async delete(key) {
    this.map.delete(key);
  }
}

function makeGate() {
  const storage = new FakeStorage();
  const gate = new LicenseGate({ storage });
  const call = async (body) => {
    const res = await gate.fetch(
      new Request("https://do/", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, json: await res.json() };
  };
  return { call, storage };
}

// --- seats ------------------------------------------------------------------

{
  const { call } = makeGate();
  await call({ op: "addSeat", deviceId: "a", limit: 2 });
  const second = await call({ op: "addSeat", deviceId: "b", limit: 2 });
  const third = await call({ op: "addSeat", deviceId: "c", limit: 2 });
  check("adding a seat under the limit succeeds", second.json.ok === true);
  check("adding a seat over the limit is refused", third.json.ok === false);
  check("over-limit add reports full", third.json.full === true);
  check(
    "over-limit add does not change the seat set",
    JSON.stringify(third.json.seats) === JSON.stringify(["a", "b"]),
  );
}

{
  const { call } = makeGate();
  await call({ op: "addSeat", deviceId: "a", limit: 2 });
  const again = await call({ op: "addSeat", deviceId: "a", limit: 2 });
  check("re-adding an existing seat is idempotent", again.json.ok === true);
  check("re-adding does not duplicate", again.json.seats.length === 1);
}

{
  const { call } = makeGate();
  await call({ op: "addSeat", deviceId: "a", limit: 3 });
  await call({ op: "addSeat", deviceId: "b", limit: 3 });
  const removed = await call({ op: "removeSeat", deviceId: "a" });
  const absent = await call({ op: "removeSeat", deviceId: "z" });
  check("removing a known seat reports removed", removed.json.removed === true);
  check(
    "removing an unknown seat reports not-removed",
    absent.json.removed === false,
  );
  const seats = await call({ op: "getSeats" });
  check("removal persists", JSON.stringify(seats.json.seats) === '["b"]');
}

{
  // Legacy KV seats are imported once; emptying the DO seats must not let the
  // stale KV copy come back on the next request.
  const { call } = makeGate();
  const first = await call({
    op: "seedSeats",
    seats: ["legacy1", "legacy2"],
    limit: 3,
  });
  check(
    "legacy seats are imported on first seed",
    JSON.stringify(first.json.seats) === '["legacy1","legacy2"]',
  );
  await call({ op: "removeSeat", deviceId: "legacy1" });
  const second = await call({
    op: "seedSeats",
    seats: ["legacy1", "legacy2"],
    limit: 3,
  });
  check(
    "re-seeding does not resurrect removed legacy seats",
    JSON.stringify(second.json.seats) === '["legacy2"]',
  );
}

// --- rate limit -------------------------------------------------------------

{
  const { call } = makeGate();
  const a = await call({ op: "rate", limit: 2, windowSecs: 60 });
  const b = await call({ op: "rate", limit: 2, windowSecs: 60 });
  const c = await call({ op: "rate", limit: 2, windowSecs: 60 });
  check("first call is allowed", a.json.limited === false);
  check("second call is allowed", b.json.limited === false);
  check("call over the limit is refused", c.json.limited === true);
}

// --- activation code --------------------------------------------------------

{
  const now = 1_000_000;
  const { call } = makeGate();
  await call({ op: "putCode", code: "123456", expiresAt: now + 600 });
  const wrong = await call({ op: "checkCode", code: "000000", now });
  const right = await call({ op: "checkCode", code: "123456", now });
  const gone = await call({ op: "checkCode", code: "123456", now });
  check("a wrong code is a mismatch", wrong.json.status === "mismatch");
  check("the right code verifies", right.json.status === "ok");
  check("a verified code is consumed", gone.json.status === "missing");
}

{
  const now = 2_000_000;
  const { call } = makeGate();
  await call({ op: "putCode", code: "123456", expiresAt: now + 600 });
  let burned = null;
  for (let i = 0; i < 5; i += 1) {
    burned = await call({ op: "checkCode", code: "000000", now });
  }
  check(
    "the code burns after the attempt budget",
    burned.json.status === "burned",
  );
  const after = await call({ op: "checkCode", code: "123456", now });
  check("a burned code stays dead", after.json.status === "missing");
}

{
  const now = 3_000_000;
  const { call } = makeGate();
  await call({ op: "putCode", code: "123456", expiresAt: now - 1 });
  const expired = await call({ op: "checkCode", code: "123456", now });
  check("an expired code is rejected", expired.json.status === "expired");
}

if (failures > 0) process.exit(1);
console.log("PASS: LicenseGate durable object");
