import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { openFileExternally } from "./openExternal";
import type { VexilAndroidBridge } from "../mobile/native";

const mockInvoke = vi.mocked(invoke);

const setBridge = (bridge?: Partial<VexilAndroidBridge>) => {
  if (!bridge) {
    delete (window as unknown as { VexilAndroid?: unknown }).VexilAndroid;
    return;
  }
  (window as unknown as { VexilAndroid?: unknown }).VexilAndroid = bridge;
};

beforeEach(() => {
  mockInvoke.mockReset();
  setBridge();
});

afterEach(() => {
  setBridge();
});

describe("openFileExternally", () => {
  it("uses the Android bridge when present", async () => {
    const openFile = vi.fn().mockReturnValue("");
    setBridge({ openFile });

    expect(
      await openFileExternally("/storage/emulated/0/Movies/clip.mp4"),
    ).toBeNull();
    expect(openFile).toHaveBeenCalledWith(
      "/storage/emulated/0/Movies/clip.mp4",
    );
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("invokes the Android bridge with the bridge as receiver", async () => {
    // Android's injected Java object refuses a detached call, so the receiver
    // is load-bearing. A plain `vi.fn()` mock cannot catch a regression here.
    const receivers: unknown[] = [];
    const bridge = {
      openFile(this: unknown) {
        receivers.push(this);
        return "";
      },
    };
    setBridge(bridge);

    expect(
      await openFileExternally("/storage/emulated/0/Movies/clip.mp4"),
    ).toBeNull();
    expect(receivers).toEqual([bridge]);
  });

  it("is not rejected by a bridge that refuses detached calls", async () => {
    const bridge = {
      openFile(this: unknown) {
        if (this !== bridge) {
          throw new Error(
            "Java bridge method can't be invoked on a non-injected object",
          );
        }
        return "";
      },
    };
    setBridge(bridge);

    expect(
      await openFileExternally("/storage/emulated/0/Movies/clip.mp4"),
    ).toBeNull();
  });

  it("returns the bridge error message", async () => {
    setBridge({ openFile: () => "No app on this device can open clip.mp4" });

    expect(
      await openFileExternally("/storage/emulated/0/Movies/clip.mp4"),
    ).toBe("No app on this device can open clip.mp4");
  });

  it("reports a bridge that throws", async () => {
    setBridge({
      openFile: () => {
        throw new Error("bridge exploded");
      },
    });

    expect(await openFileExternally("/tmp/clip.mp4")).toBe("bridge exploded");
  });

  it("falls back to the Rust command without a bridge", async () => {
    mockInvoke.mockResolvedValue("Opened");

    expect(await openFileExternally("C:/Users/me/clip.mp4")).toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith("open_file_external", {
      path: "C:/Users/me/clip.mp4",
    });
  });

  it("falls back when the bridge lacks openFile", async () => {
    setBridge({ pickFolder: () => {} });
    mockInvoke.mockResolvedValue("Opened");

    expect(await openFileExternally("/tmp/clip.mp4")).toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith("open_file_external", {
      path: "/tmp/clip.mp4",
    });
  });

  it("surfaces command failures", async () => {
    mockInvoke.mockRejectedValue(new Error("File not found: /tmp/clip.mp4"));

    expect(await openFileExternally("/tmp/clip.mp4")).toBe(
      "File not found: /tmp/clip.mp4",
    );
  });

  it("falls back to a generic message for non-Error rejections", async () => {
    mockInvoke.mockRejectedValue("boom");

    expect(await openFileExternally("/tmp/clip.mp4")).toBe(
      "Could not open /tmp/clip.mp4",
    );
  });
});
