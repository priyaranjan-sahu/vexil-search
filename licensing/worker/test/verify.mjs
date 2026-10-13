// Exercises the worker's `/verify` endpoint end to end against a fake KV
// namespace. `/verify` is what lets the client drop a license that was
// refunded or canceled, so it must say "inactive" only on a definite answer.
// Run inside the worker dir:  node test/verify.mjs

import worker from "../src/index.js";
import { FakeGate, FakeKV } from "./helpers.mjs";

let failures = 0;
function check(name, cond) {
  if (!cond) {
    console.error(`FAIL: ${name}`);
    failures += 1;
  } else {
    console.log(`ok: ${name}`);
  }
}

const DEVICE = "0123456789abcdef";

function makeEnv(customer, seats) {
  return {
    CUSTOMERS: new FakeKV(
      customer ? { "customer:u@vexil.app": JSON.stringify(customer) } : {},
    ),
    SEATS: new FakeKV(
      seats ? { "seats:u@vexil.app": JSON.stringify(seats) } : {},
    ),
    GATE: new FakeGate(),
  };
}

async function verify(env, body, ip) {
  const headers = { "Content-Type": "application/json" };
  if (ip) headers["CF-Connecting-IP"] = ip;
  const res = await worker.fetch(
    new Request("https://lic.example/verify", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    env,
  );
  return { status: res.status, json: await res.json() };
}

const activeEnv = makeEnv({ active: true, recurring: null, updatedAt: 0 }, [
  DEVICE,
]);

{
  const { status, json } = await verify(activeEnv, {
    email: "u@vexil.app",
    deviceId: DEVICE,
  });
  check(
    "active customer on a registered device is active",
    status === 200 && json.active === true,
  );
}

{
  const { json } = await verify(activeEnv, {
    email: "u@vexil.app",
    deviceId: "ffffffffffffffff",
  });
  check("an unregistered device is not active", json.active === false);
}

{
  const inactiveEnv = makeEnv({ active: false }, [DEVICE]);
  const { json } = await verify(inactiveEnv, {
    email: "u@vexil.app",
    deviceId: DEVICE,
  });
  check("a refunded/canceled customer is not active", json.active === false);
}

{
  const { json } = await verify(activeEnv, {
    email: "unknown@vexil.app",
    deviceId: DEVICE,
  });
  check("an unknown email is not active", json.active === false);
}

{
  const { status } = await verify(activeEnv, { email: "u@vexil.app" });
  check("missing deviceId is a 400", status === 400);
}

{
  // Distinct IP so it has its own budget; VERIFY_PER_IP is 30/min.
  const env = makeEnv({ active: true }, [DEVICE]);
  let limited = false;
  for (let i = 0; i < 31; i += 1) {
    const { status } = await verify(
      env,
      { email: "u@vexil.app", deviceId: DEVICE },
      "203.0.113.9",
    );
    if (status === 429) {
      limited = true;
      break;
    }
  }
  check("verify is rate limited per IP", limited === true);
}

if (failures > 0) process.exit(1);
console.log("PASS: /verify active check");
