import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useSearchStore } from "./searchStore";

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
  useSearchStore.setState({
    query: "",
    results: [],
    browseSections: [],
    activeCategory: "All",
  });
});

describe("searchStore browse mode", () => {
  it("loads browse sections when the query is empty", async () => {
    invokeMock.mockResolvedValue([{ category: "Images", count: 3, files: [] }]);

    await useSearchStore.getState().runSearch("");

    expect(invokeMock).toHaveBeenCalledWith("browse_files", {
      category: "All",
    });
    expect(useSearchStore.getState().browseSections).toHaveLength(1);
    expect(useSearchStore.getState().results).toEqual([]);
  });

  it("browses the active category for a whitespace-only query", async () => {
    useSearchStore.setState({ activeCategory: "Music" });
    invokeMock.mockResolvedValue([]);

    await useSearchStore.getState().runSearch("   ");

    expect(invokeMock).toHaveBeenCalledWith("browse_files", {
      category: "Music",
    });
  });

  it("clears browse sections once a search starts", async () => {
    useSearchStore.setState({
      browseSections: [{ category: "Images", count: 1, files: [] }],
    });
    invokeMock.mockResolvedValue([]);

    await useSearchStore.getState().runSearch("photo", true);

    expect(useSearchStore.getState().browseSections).toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith("search_files", {
      query: "photo",
      category: "All",
    });
  });

  it("ignores malformed browse responses", async () => {
    invokeMock.mockResolvedValue(42);

    await useSearchStore.getState().runSearch("");

    expect(useSearchStore.getState().browseSections).toEqual([]);
  });
});
