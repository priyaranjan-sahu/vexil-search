import { describe, expect, it } from "vitest";
import { resolveLicenseServer } from "./licenseStore";

describe("resolveLicenseServer", () => {
  // A shipped build that falls back to localhost points activation at the
  // user's own machine, so activation fails with a connection error that says
  // nothing about the real cause.
  it("never falls back to localhost in a shipped build", () => {
    expect(resolveLicenseServer(undefined, false)).toBe("");
    expect(resolveLicenseServer("", false)).toBe("");
    expect(resolveLicenseServer("   ", false)).toBe("");
  });

  it("falls back to localhost only for dev builds", () => {
    expect(resolveLicenseServer(undefined, true)).toBe("http://localhost:8787");
  });

  it("prefers the configured server and trims it", () => {
    expect(resolveLicenseServer("https://lic.vexil.app/", false)).toBe(
      "https://lic.vexil.app/",
    );
    expect(resolveLicenseServer("https://lic.vexil.app", true)).toBe(
      "https://lic.vexil.app",
    );
  });

  it("treats a blank configured value as unset", () => {
    expect(resolveLicenseServer("  ", true)).toBe("http://localhost:8787");
  });
});
