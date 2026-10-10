import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { FEATURES, hasFeature, useLicenseStore } from "./licenseStore";
import { useSearchStore } from "./searchStore";

const invokeMock = vi.mocked(invoke);
const messageMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({ message: messageMock }));

/** Mirrors `get_license_status` + `get_entitlements` from the Rust side. */
function mockLicense(granted: string[]) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "get_license_status") {
      return {
        pro: granted.length > 0,
        plan: granted.length > 0 ? "pro" : "free",
        features: granted,
        userId: "u1",
        issuedAt: 0,
        expiresAt: null,
        reason: "Licensed",
      };
    }
    if (cmd === "get_entitlements") {
      return granted;
    }
    return null;
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  useLicenseStore.setState({ status: null, entitlements: [] });
  useSearchStore.setState({ myPicks: [] });
  messageMock.mockReset();
});

describe("hasFeature", () => {
  it("denies everything when entitlements are not loaded yet", () => {
    expect(hasFeature(FEATURES.background)).toBe(false);
    expect(hasFeature(FEATURES.unlimitedPicks)).toBe(false);
  });

  it("grants only what the backend resolved", () => {
    useLicenseStore.setState({
      entitlements: [FEATURES.background],
    });
    expect(hasFeature(FEATURES.background)).toBe(true);
    expect(hasFeature(FEATURES.removableDrives)).toBe(false);
    expect(hasFeature(FEATURES.unlimitedPicks)).toBe(false);
  });

  it("loads entitlements from the backend on refresh", async () => {
    mockLicense([FEATURES.unlimitedPicks]);
    await useLicenseStore.getState().refresh();
    expect(useLicenseStore.getState().entitlements).toEqual([
      FEATURES.unlimitedPicks,
    ]);
  });
});

describe("My Picks gate", () => {
  const picks = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `f${i}`,
      path: `/f${i}`,
      name: `f${i}`,
    }));

  it("sends the pick for a license that grants unlimited_picks", async () => {
    useLicenseStore.setState({ entitlements: [FEATURES.unlimitedPicks] });
    useSearchStore.setState({ myPicks: picks(5) as never });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_my_picks") return [...picks(5), { id: "extra" }];
      return null;
    });

    await useSearchStore.getState().addMyPick({
      id: "extra",
      path: "/extra",
      name: "extra",
    } as never);

    expect(invokeMock).toHaveBeenCalledWith("add_my_pick", {
      pick: { id: "extra", path: "/extra", name: "extra" },
    });
    expect(messageMock).not.toHaveBeenCalled();
    expect(useSearchStore.getState().myPicks).toHaveLength(6);
  });
});

describe("background gate", () => {
  it("blocks enabling for a license without the background feature", () => {
    useLicenseStore.setState({ entitlements: [FEATURES.unlimitedPicks] });
    useSearchStore.getState().setRunInBackground(true);
    expect(messageMock).toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith(
      "set_run_in_background",
      expect.anything(),
    );
  });

  it("allows enabling when the background feature is granted", () => {
    useLicenseStore.setState({ entitlements: [FEATURES.background] });
    useSearchStore.getState().setRunInBackground(true);
    expect(messageMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("set_run_in_background", {
      enable: true,
    });
  });
});
