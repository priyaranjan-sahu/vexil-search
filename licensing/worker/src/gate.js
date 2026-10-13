// Durable Object that serialises seat, rate-limit and activation-code
// mutations for a single key.
//
// Why this exists: Cloudflare KV is eventually consistent and has no
// compare-and-set, so the previous "read array -> check -> write array" seat
// logic could exceed SEAT_LIMIT under concurrency (two activations read len < 3
// and both write). A Durable Object handles one request at a time, which makes
// the same read-modify-write atomic without inventing a CAS primitive.
//
// The object is addressed by name: `seat:<email>`, `rl:<key>`, or
// `code:<email>`, so each logical counter lives in its own single-threaded
// object. All operations arrive over `fetch` (rather than RPC) so the class can
// be unit-tested in plain Node with a fake storage object.

import { constantTimeEqual, EMAIL_CODE_MAX_ATTEMPTS } from "./lib.js";

export class LicenseGate {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid body" }, { status: 400 });
    }
    try {
      switch (body?.op) {
        case "rate":
          return Response.json(await this.#rate(body));
        case "getSeats":
          return Response.json({ seats: await this.#getSeats() });
        case "seedSeats":
          return Response.json({ seats: await this.#seedSeats(body) });
        case "addSeat":
          return Response.json(await this.#addSeat(body));
        case "removeSeat":
          return Response.json(await this.#removeSeat(body));
        case "putCode":
          await this.#putCode(body);
          return Response.json({ ok: true });
        case "checkCode":
          return Response.json(await this.#checkCode(body));
        default:
          return Response.json({ error: "unknown op" }, { status: 400 });
      }
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
  }

  // Fixed-window counter. Atomic because the object is single-threaded.
  async #rate({ limit, windowSecs }) {
    const bucket = Math.floor(Date.now() / 1000 / windowSecs);
    const cur = (await this.storage.get("rl")) || null;
    if (!cur || cur.bucket !== bucket) {
      await this.storage.put("rl", { bucket, count: 1 });
      return { limited: false };
    }
    if (cur.count >= limit) return { limited: true };
    await this.storage.put("rl", { bucket, count: cur.count + 1 });
    return { limited: false };
  }

  async #getSeats() {
    const seats = await this.storage.get("seats");
    return Array.isArray(seats) ? seats : [];
  }

  // One-time import of seats recorded under the old KV layout. The `seeded`
  // marker makes this idempotent so emptying the seats does not resurrect the
  // stale KV copy on the next request.
  async #seedSeats({ seats, limit }) {
    if (!(await this.storage.get("seeded"))) {
      const current = await this.#getSeats();
      if (current.length === 0 && Array.isArray(seats) && seats.length > 0) {
        await this.storage.put("seats", seats.slice(0, limit));
      }
      await this.storage.put("seeded", true);
    }
    return this.#getSeats();
  }

  async #addSeat({ deviceId, limit }) {
    const seats = await this.#getSeats();
    if (seats.includes(deviceId)) return { ok: true, seats };
    if (seats.length >= limit) return { ok: false, full: true, seats };
    const next = [...seats, deviceId];
    await this.storage.put("seats", next);
    return { ok: true, seats: next };
  }

  async #removeSeat({ deviceId }) {
    const seats = await this.#getSeats();
    const next = seats.filter((d) => d !== deviceId);
    if (next.length !== seats.length) await this.storage.put("seats", next);
    return { removed: next.length !== seats.length, seats: next };
  }

  async #putCode({ code, expiresAt }) {
    await this.storage.put("code", { code, expiresAt, attempts: 0 });
  }

  // Returns one of: ok | missing | expired | burned | mismatch.
  async #checkCode({ code, now }) {
    const rec = await this.storage.get("code");
    if (!rec) return { status: "missing" };
    if (rec.expiresAt < now) {
      await this.storage.delete("code");
      return { status: "expired" };
    }
    if (rec.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
      await this.storage.delete("code");
      return { status: "burned" };
    }
    if (!constantTimeEqual(rec.code, String(code ?? ""))) {
      rec.attempts += 1;
      if (rec.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
        await this.storage.delete("code");
        return { status: "burned" };
      }
      await this.storage.put("code", rec);
      return { status: "mismatch" };
    }
    await this.storage.delete("code");
    return { status: "ok" };
  }
}
