import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  applyUpdate,
  checkForUpdates,
  openReleasePage,
  resetUpdateCheckCache,
  type UpdateInfo,
} from "./updates";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.reject("not mocked")),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));

const mockedInvoke = vi.mocked(invoke);
const mockedOpenUrl = vi.mocked(openUrl);

const updateInfo = (overrides: Partial<UpdateInfo> = {}): UpdateInfo => ({
  update_available: true,
  current_version: "0.1.0",
  latest_version: "0.2.0",
  release_url:
    "https://github.com/priyaranjan-sahu/vexil-search/releases/tag/0.2.0",
  notes: "Fixes.",
  published_at: "2026-10-01T00:00:00Z",
  ...overrides,
});

describe("checkForUpdates", () => {
  beforeEach(() => {
    resetUpdateCheckCache();
    mockedInvoke.mockReset();
  });

  it("returns the update info when a newer release exists", async () => {
    mockedInvoke.mockResolvedValue(updateInfo());
    await expect(checkForUpdates()).resolves.toEqual(updateInfo());
  });

  it("returns null when the installed version is current", async () => {
    mockedInvoke.mockResolvedValue(updateInfo({ update_available: false }));
    await expect(checkForUpdates()).resolves.toBeNull();
  });

  it("returns null when the check fails (offline, rate-limited, no Tauri)", async () => {
    mockedInvoke.mockRejectedValue(new Error("network down"));
    await expect(checkForUpdates()).resolves.toBeNull();
  });

  it("returns null for unexpected payloads instead of crashing", async () => {
    mockedInvoke.mockResolvedValue(42 as unknown as UpdateInfo);
    await expect(checkForUpdates()).resolves.toBeNull();
  });

  it("checks only once per session", async () => {
    mockedInvoke.mockResolvedValue(updateInfo());
    await checkForUpdates();
    await checkForUpdates();
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
  });
});

describe("openReleasePage", () => {
  beforeEach(() => {
    mockedOpenUrl.mockReset();
  });

  it("opens the release URL with the system opener", async () => {
    mockedOpenUrl.mockResolvedValue(undefined);
    const info = updateInfo();
    await openReleasePage(info);
    expect(mockedOpenUrl).toHaveBeenCalledWith(info.release_url);
  });

  it("falls back to a browser tab when the opener is unavailable", async () => {
    mockedOpenUrl.mockRejectedValue(new Error("no opener"));
    const spy = vi.spyOn(window, "open").mockImplementation(() => null);
    const info = updateInfo();
    await openReleasePage(info);
    expect(spy).toHaveBeenCalledWith(info.release_url, "_blank", "noopener");
    spy.mockRestore();
  });
});

describe("applyUpdate", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedOpenUrl.mockReset();
  });

  it("installs through the updater and never touches the browser", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    const info = updateInfo();
    await applyUpdate(info);
    expect(mockedInvoke).toHaveBeenCalledWith("install_update");
    expect(mockedOpenUrl).not.toHaveBeenCalled();
  });

  it("falls back to the release page when auto-install is unavailable", async () => {
    mockedInvoke.mockRejectedValue(
      new Error("Auto-install is only available on desktop."),
    );
    mockedOpenUrl.mockResolvedValue(undefined);
    const info = updateInfo();
    await applyUpdate(info);
    expect(mockedOpenUrl).toHaveBeenCalledWith(info.release_url);
  });
});
