import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { getPlatform, isMobilePlatform, resetPlatformCache } from "./platform";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  resetPlatformCache();
  mockInvoke.mockReset();
});

describe("getPlatform", () => {
  it("returns android", async () => {
    mockInvoke.mockResolvedValue("android");
    expect(await getPlatform()).toBe("android");
  });

  it("returns ios", async () => {
    mockInvoke.mockResolvedValue("ios");
    expect(await getPlatform()).toBe("ios");
  });

  it("returns desktop for unknown values", async () => {
    mockInvoke.mockResolvedValue("web");
    expect(await getPlatform()).toBe("desktop");
  });

  it("falls back to desktop when the backend is unavailable", async () => {
    mockInvoke.mockRejectedValue(new Error("no backend"));
    expect(await getPlatform()).toBe("desktop");
  });

  it("caches the resolved value", async () => {
    mockInvoke.mockResolvedValue("android");
    await getPlatform();
    await getPlatform();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });
});

describe("isMobilePlatform", () => {
  it("is true for android and ios, false for desktop", () => {
    expect(isMobilePlatform("android")).toBe(true);
    expect(isMobilePlatform("ios")).toBe(true);
    expect(isMobilePlatform("desktop")).toBe(false);
  });
});
