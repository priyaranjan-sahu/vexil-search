import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useSearchStore } from "../store/searchStore";
import { resetPlatformCache } from "../lib/platform";
import { MobileApp } from "./MobileApp";

const mockInvoke = vi.mocked(invoke);

const baseImpl = (cmd: string) => {
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
};

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
  mockInvoke.mockImplementation(baseImpl);
});

afterEach(() => {
  delete (window as unknown as { VexilAndroid?: unknown }).VexilAndroid;
  delete (navigator as { clipboard?: unknown }).clipboard;
  vi.useRealTimers();
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

  it("shows 'Path copied' only when the clipboard write succeeds", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "search_files")
        return Promise.resolve([
          {
            id: 1,
            title: "report.pdf",
            snippet: "matched",
            path: "/docs/report.pdf",
            relevance: 88,
            size: 2048,
            modified: 1700000000,
            category: "Documents",
          },
        ]);
      return baseImpl(cmd);
    });
    useSearchStore.setState({ query: "report", results: [] });
    render(<MobileApp />);
    // Let the 250ms live-search debounce run, then drain its promise.
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    fireEvent.contextMenu(screen.getByText("report.pdf"));
    fireEvent.click(screen.getByText("Copy Path"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith("/docs/report.pdf");
    expect(screen.getByText("Path copied")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("scans without All Files Access by indexing picked folders via SAF", async () => {
    const openAllFilesAccess = vi.fn();
    (window as unknown as { VexilAndroid?: unknown }).VexilAndroid = {
      hasAllFilesAccess: () => false,
      openAllFilesAccess,
      pickFolder: vi.fn(),
    };
    render(<MobileApp />);
    await flush();
    // Picked folders are reached through the Storage Access Framework, so a
    // scan still runs even when the broad permission is missing.
    expect(
      mockInvoke.mock.calls.some(([cmd]) => cmd === "start_indexing"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Allow Access" }));
    expect(openAllFilesAccess).toHaveBeenCalledTimes(1);
  });

  it("adds a picked folder with its SAF tree uri", async () => {
    (window as unknown as { VexilAndroid?: unknown }).VexilAndroid = {
      hasAllFilesAccess: () => false,
      openAllFilesAccess: vi.fn(),
      pickFolder: vi.fn(),
    };
    render(<MobileApp />);
    await flush();
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("vexil:folder-picked", {
          detail: {
            path: "/storage/emulated/0/Docs",
            name: "Docs",
            uri: "content://com.android.externalstorage.documents/tree/primary%3ADocs",
          },
        }),
      );
      await Promise.resolve();
    });
    const call = mockInvoke.mock.calls.find(
      ([cmd]) => cmd === "add_mobile_root",
    );
    expect(call?.[1]).toMatchObject({
      path: "/storage/emulated/0/Docs",
      name: "Docs",
      uri: "content://com.android.externalstorage.documents/tree/primary%3ADocs",
    });
  });

  it("shows an error toast when the clipboard write fails", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(() => Promise.reject(new Error("denied")));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "search_files")
        return Promise.resolve([
          {
            id: 1,
            title: "report.pdf",
            snippet: "matched",
            path: "/docs/report.pdf",
            relevance: 88,
            size: 2048,
            modified: 1700000000,
            category: "Documents",
          },
        ]);
      return baseImpl(cmd);
    });
    useSearchStore.setState({ query: "report", results: [] });
    render(<MobileApp />);
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    fireEvent.contextMenu(screen.getByText("report.pdf"));
    fireEvent.click(screen.getByText("Copy Path"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Could not copy path")).toBeInTheDocument();
    vi.useRealTimers();
  });
});
