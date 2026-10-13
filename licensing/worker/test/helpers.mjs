// Shared fakes for the worker tests. Kept in one place so the KV, Durable
// Object and full-worker tests exercise the same shapes.

import { LicenseGate } from "../src/gate.js";

export class FakeKV {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial));
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

// Stands in for the Durable Object namespace binding (`env.GATE`): name ->
// single-threaded storage, exactly like one object per key.
export class FakeGate {
  constructor() {
    this.stores = new Map();
  }
  idFromName(name) {
    return name;
  }
  get(name) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeStorage());
    const storage = this.stores.get(name);
    return {
      fetch: (url, init) =>
        new LicenseGate({ storage }).fetch(new Request(url, init)),
    };
  }
}
