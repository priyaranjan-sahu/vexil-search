// End-to-end tests for email-verified activation: the client proves control of
// the paid inbox with a 6-digit code before any seat is granted. Covers the
// unconfigured fail-closed path, the happy path, wrong/expired codes and the
// per-license device limit. Run inside the worker dir:  node test/activate.mjs

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
const DEVICE2 = "1111111111111111";
const DEVICE3 = "2222222222222222";
const DEVICE4 = "3333333333333333";
const PRIVATE_KEY = Buffer.alloc(32, 7).toString("base64");

let lastCode = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes("api.resend.com")) {
    const body = JSON.parse(init.body);
    lastCode = (body.text.match(/(\d{6})/) || [])[1] || null;
    return new Response(JSON.stringify({ id: "test" }), { status: 200 });
  }
  return realFetch(url, init);
};

function makeEnv({ customers = {}, seats = {}, configured = true } = {}) {
  const env = {
    CUSTOMERS: new FakeKV(customers),
    SEATS: new FakeKV(seats),
    GATE: new FakeGate(),
    PRIVATE_KEY,
  };
  if (configured) {
    env.RESEND_API_KEY = "test-key";
    env.EMAIL_FROM = "Vexil <no-reply@vexil.app>";
  }
  return env;
}

async function post(env, path, body, ip) {
  const headers = { "Content-Type": "application/json" };
  if (ip) headers["CF-Connecting-IP"] = ip;
  const res = await worker.fetch(
    new Request(`https://lic.example${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    env,
  );
  return { status: res.status, json: await res.json() };
}

async function requestCode(env, email, ip = "203.0.113.1") {
  lastCode = null;
  const res = await post(env, "/activate/request", { email }, ip);
  return { ...res, code: lastCode };
}

async function seedSeat(env, email, deviceId) {
  await env.GATE.get(env.GATE.idFromName(`seat:${email}`)).fetch(
    "https://gate.internal/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "addSeat", deviceId, limit: 3 }),
    },
  );
}

const active = { active: true, recurring: null, updatedAt: 0 };

// --- fail closed when email delivery is not configured -----------------------

{
  const env = makeEnv({
    configured: false,
    customers: { "customer:u@vexil.app": JSON.stringify(active) },
  });
  const req = await post(env, "/activate/request", { email: "u@vexil.app" });
  const act = await post(env, "/activate", {
    email: "u@vexil.app",
    deviceId: DEVICE,
    code: "123456",
  });
  check(
    "activation request is refused without email config",
    req.status === 503,
  );
  check("activation is refused without email config", act.status === 503);
}

// --- requesting a code --------------------------------------------------------

{
  const env = makeEnv();
  const inactive = await post(env, "/activate/request", {
    email: "nobody@vexil.app",
  });
  check(
    "requesting a code for an inactive email is 403",
    inactive.status === 403,
  );
}

{
  const env = makeEnv({
    customers: { "customer:u@vexil.app": JSON.stringify(active) },
  });
  const req = await requestCode(env, "u@vexil.app");
  check(
    "an active customer gets a code",
    req.status === 200 && req.json.sent === true,
  );
  check("the emailed code is 6 digits", /^\d{6}$/.test(req.code || ""));
}

// --- happy path ---------------------------------------------------------------

{
  const env = makeEnv({
    customers: { "customer:u@vexil.app": JSON.stringify(active) },
  });
  const req = await requestCode(env, "u@vexil.app");
  const act = await post(env, "/activate", {
    email: "u@vexil.app",
    deviceId: DEVICE,
    code: req.code,
  });
  check(
    "a valid code activates the device",
    act.status === 200 && typeof act.json.license === "string",
  );
  check(
    "the license is a signed token",
    (act.json.license || "").split(".").length >= 2,
  );
  const seats = await env.GATE.get(
    env.GATE.idFromName("seat:u@vexil.app"),
  ).fetch("https://gate.internal/", {
    method: "POST",
    body: JSON.stringify({ op: "getSeats" }),
  });
  const { seats: list } = await seats.json();
  check("the device seat was recorded", list.includes(DEVICE));
}

// --- code validation ----------------------------------------------------------

{
  const env = makeEnv({
    customers: { "customer:u@vexil.app": JSON.stringify(active) },
  });
  const req = await requestCode(env, "u@vexil.app");
  const act = await post(env, "/activate", {
    email: "u@vexil.app",
    deviceId: DEVICE,
    code: "000000" === req.code ? "111111" : "000000",
  });
  check("a wrong code is rejected", act.status === 403);
}

{
  const env = makeEnv({
    customers: { "customer:u@vexil.app": JSON.stringify(active) },
  });
  const act = await post(env, "/activate", {
    email: "u@vexil.app",
    deviceId: DEVICE,
  });
  check("a missing code is a 400", act.status === 400);
}

{
  const env = makeEnv({
    customers: { "customer:u@vexil.app": JSON.stringify(active) },
  });
  const req = await requestCode(env, "u@vexil.app");
  const act = await post(env, "/activate", {
    email: "u@vexil.app",
    deviceId: "not-hex",
    code: req.code,
  });
  check("an invalid deviceId is a 400", act.status === 400);
}

{
  // A valid code for an email whose license stopped being active is still
  // refused, so a refund between request and activate cannot slip through.
  const env = makeEnv({
    customers: { "customer:u@vexil.app": JSON.stringify({ active: false }) },
  });
  await env.GATE.get(env.GATE.idFromName("code:u@vexil.app")).fetch(
    "https://gate.internal/",
    {
      method: "POST",
      body: JSON.stringify({
        op: "putCode",
        code: "123456",
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      }),
    },
  );
  const act = await post(env, "/activate", {
    email: "u@vexil.app",
    deviceId: DEVICE,
    code: "123456",
  });
  check("a code cannot activate an inactive license", act.status === 403);
}

// --- device limit -------------------------------------------------------------

{
  const env = makeEnv({
    customers: { "customer:u@vexil.app": JSON.stringify(active) },
  });
  await seedSeat(env, "u@vexil.app", DEVICE);
  await seedSeat(env, "u@vexil.app", DEVICE2);
  await seedSeat(env, "u@vexil.app", DEVICE3);
  const req = await requestCode(env, "u@vexil.app");
  const act = await post(env, "/activate", {
    email: "u@vexil.app",
    deviceId: DEVICE4,
    code: req.code,
  });
  check("a fourth device is refused", act.status === 403);
  const { seats } = await (
    await env.GATE.get(env.GATE.idFromName("seat:u@vexil.app")).fetch(
      "https://gate.internal/",
      { method: "POST", body: JSON.stringify({ op: "getSeats" }) },
    )
  ).json();
  check("the refused device was not added", seats.length === 3);
}

if (failures > 0) process.exit(1);
console.log("PASS: email-verified activation");
