import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useSearchStore } from "../store/searchStore";
import { resetPlatformCache } from "../lib/platform";
import { MobileApp } from "./MobileApp";

const mockInvoke = vi.mocked(invoke);

// Drains the microtask queue so async boot/indexing invokes settle inside act.
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

beforeEach(() => {
  resetPlatformCache();
  useSearchStore.setState({
    query: "",
    results: [],
    myPicks: [],
    recentItems: [],
    activeCategory: "All",
    activeSizeFilter: "Any Size",
    activeDateFilter: "Any Time",
    indexingProgress: null,
    dbTotalCount: 0,
  });
  mockInvoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "get_platform":
        return Promise.resolve("android");
      case "search_files":
        return Promise.resolve([]);
      case "start_indexing":
        return Promise.resolve("started");
      case "get_index_stats":
        return Promise.resolve(0);
      case "get_mobile_roots":
        return Promise.resolve([]);
      case "add_mobile_root":
      case "remove_mobile_root":
        return Promise.resolve([]);
      default:
        return Promise.resolve(undefined);
    }
  });
});

afterEach(() => {
  delete (window as unknown as { VexilAndroid?: unknown }).VexilAndroid;
});

describe("MobileApp shell", () => {
  it("renders the header and all four tabs", async () => {
    render(<MobileApp />);
    await flush();
    expect(screen.getByText("Vexil")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Picks" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recent" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Settings" }),
    ).toBeInTheDocument();
  });

  it("switches to the Picks tab", async () => {
    render(<MobileApp />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Picks" }));
    expect(screen.getByText("My Picks")).toBeInTheDocument();
  });

  it("switches to the Recent tab", async () => {
    render(<MobileApp />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Recent" }));
    expect(
      screen.getByText("Opened files will appear here"),
    ).toBeInTheDocument();
  });

  it("switches to Settings and shows the license section", async () => {
    render(<MobileApp />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("Pro License")).toBeInTheDocument();
  });

  it("shows the Android access controls when all-files access is missing", async () => {
    (window as unknown as { VexilAndroid?: unknown }).VexilAndroid = {
      hasAllFilesAccess: () => false,
      openAllFilesAccess: vi.fn(),
      pickFolder: vi.fn(),
    };
    render(<MobileApp />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByText("Grant Access")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Add Folder" }),
    ).toBeInTheDocument();
  });
});
