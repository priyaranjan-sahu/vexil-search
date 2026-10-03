import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SearchResult } from "./searchStore";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

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

describe("handleDelete", () => {
  it("does not delete when the confirmation is declined", async () => {
    window.confirm = () => false;
    const useSearchStore = await freshStore();
    useSearchStore.setState({ selectedResult: pick(1) });

    await useSearchStore.getState().handleDelete();

    expect(invoke).not.toHaveBeenCalledWith("delete_file", expect.anything());
    expect(useSearchStore.getState().selectedResult).not.toBeNull();
  });

  it("deletes once the confirmation is accepted", async () => {
    window.confirm = () => true;
    const useSearchStore = await freshStore();
    const target = pick(2);
    useSearchStore.setState({ selectedResult: target, results: [target] });

    await useSearchStore.getState().handleDelete();

    expect(invoke).toHaveBeenCalledWith("delete_file", { path: target.path });
    expect(useSearchStore.getState().results).toEqual([]);
    expect(useSearchStore.getState().selectedResult).toBeNull();
  });

  it("does nothing when there is no selection", async () => {
    window.confirm = () => true;
    const useSearchStore = await freshStore();

    await useSearchStore.getState().handleDelete();

    expect(invoke).not.toHaveBeenCalled();
  });
});
