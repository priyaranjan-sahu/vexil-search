import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SearchResult } from "./searchStore";

const invoke = vi.hoisted(() => vi.fn());
const messageMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: messageMock }));

const pick = (id: number): SearchResult => ({
  id,
  path: `/data/file${id}.mp4`,
  size: id,
  modified: 1_700_000_000,
  category: "Video",
  title: `file${id}.mp4`,
  snippet: "",
  relevance: 1,
});

async function freshStore() {
  vi.resetModules();
  const mod = await import("./searchStore");
  return mod.useSearchStore;
}

beforeEach(() => {
  invoke.mockReset();
  localStorage.clear();
});

describe("My Picks backend ownership", () => {
  it("loads picks from the backend rather than local storage", async () => {
    invoke.mockResolvedValue([pick(1), pick(2)]);
    const useSearchStore = await freshStore();

    await useSearchStore.getState().loadMyPicks();

    expect(invoke).toHaveBeenCalledWith("list_my_picks");
    expect(useSearchStore.getState().myPicks.map((p) => p.id)).toEqual([1, 2]);
  });

  it("persists an added pick through the backend", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_my_picks") return [pick(7)];
      return undefined;
    });
    const useSearchStore = await freshStore();

    await useSearchStore.getState().addMyPick(pick(7));

    expect(invoke).toHaveBeenCalledWith("add_my_pick", { pick: pick(7) });
    expect(useSearchStore.getState().myPicks.map((p) => p.id)).toEqual([7]);
  });

  it("does not re-add a pick that is already saved", async () => {
    invoke.mockResolvedValue([pick(3)]);
    const useSearchStore = await freshStore();

    await useSearchStore.getState().loadMyPicks();
    await useSearchStore.getState().addMyPick(pick(3));

    expect(invoke).not.toHaveBeenCalledWith("add_my_pick", {
      pick: pick(3),
    });
  });

  it("surfaces the backend rejection when the free-tier cap is hit", async () => {
    messageMock.mockResolvedValue(undefined);
    invoke.mockRejectedValue("Free tier is limited to 5 My Picks.");
    const useSearchStore = await freshStore();

    await useSearchStore.getState().addMyPick(pick(9));

    expect(messageMock).toHaveBeenCalledWith(
      "Free tier is limited to 5 My Picks.",
    );
    expect(useSearchStore.getState().myPicks).toEqual([]);
  });

  it("rolls back the optimistic removal when the backend rejects it", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_my_picks") return [pick(4)];
      if (cmd === "remove_my_pick") throw new Error("db locked");
      return undefined;
    });
    const useSearchStore = await freshStore();

    await useSearchStore.getState().loadMyPicks();
    await useSearchStore.getState().removeMyPick(4);

    expect(useSearchStore.getState().myPicks.map((p) => p.id)).toEqual([4]);
  });
});

describe("stale selection is cleared on new result sets", () => {
  it("clears the selected result when a search returns", async () => {
    invoke.mockResolvedValue([pick(1)]);
    const useSearchStore = await freshStore();
    // A row was selected, then the user searched again: the old row is no
    // longer on screen, so keeping it selected would let Delete act on a file
    // the user is not looking at.
    useSearchStore.setState({ selectedResult: pick(99) });

    await useSearchStore.getState().runSearch("new query", true);

    expect(useSearchStore.getState().results.map((r) => r.id)).toEqual([1]);
    expect(useSearchStore.getState().selectedResult).toBeNull();
  });

  it("clears the selected result when browse sections refresh", async () => {
    invoke.mockResolvedValue([]);
    const useSearchStore = await freshStore();
    useSearchStore.setState({ selectedResult: pick(7) });

    await useSearchStore.getState().runBrowse();

    expect(useSearchStore.getState().selectedResult).toBeNull();
  });
});
