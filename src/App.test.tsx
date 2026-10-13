import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import { useSearchStore, SearchResult } from "./store/searchStore";
import { useLicenseStore } from "./store/licenseStore";

// Mock Tauri APIs
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(42)),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
  register: vi.fn(),
  isRegistered: vi.fn(() => Promise.resolve(false)),
}));

const messageMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: messageMock,
  confirm: confirmMock,
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(() => Promise.resolve("9.9.9")),
}));

const flushEffects = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const selectedResult: SearchResult = {
  id: 1,
  title: "report.pdf",
  snippet: "Annual report",
  path: "C:\\Reports\\report.pdf",
  relevance: 0.9,
  size: 2048,
  modified: 1700000000000,
  category: "Documents",
};

describe("App Component", () => {
  beforeEach(() => {
    useSearchStore.setState({
      selectedResult: null,
      showTrash: false,
      showAbout: false,
      activeSizeFilter: "Any Size",
      activeDateFilter: "Any Time",
    });
    vi.mocked(invoke).mockImplementation(() => Promise.resolve(42));
    messageMock.mockReset();
    confirmMock.mockReset();
  });

  it("renders the search input", async () => {
    render(<App />);
    const searchInput = screen.getByPlaceholderText(
      /search documents, apps, files/i,
    );
    expect(searchInput).toBeInTheDocument();
    await flushEffects();
  });

  it("updates category filter when a filter button is clicked", async () => {
    render(<App />);
    const imagesBtn = screen.getByText("Images");
    fireEvent.click(imagesBtn);
    expect(imagesBtn).toHaveClass("active");
    await flushEffects();
  });

  it("Cmd+N clears the query and refocuses the search box (macOS)", async () => {
    render(<App />);
    const input = screen.getByPlaceholderText(/search documents, apps, files/i);
    fireEvent.change(input, { target: { value: "hello" } });
    expect(input).toHaveValue("hello");
    fireEvent.keyDown(window, { key: "n", metaKey: true });
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    await flushEffects();
  });

  it("Ctrl+C copies the selected row path but leaves text fields alone", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "search_files") return Promise.resolve([selectedResult]);
      return Promise.resolve(42);
    });
    useSearchStore.setState({
      selectedResult,
      results: [selectedResult],
      query: "report",
    });
    render(<App />);
    const input = screen.getByPlaceholderText(/search documents, apps, files/i);

    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    expect(writeText).toHaveBeenCalledWith(selectedResult.path);

    // Typing in the search box must not hijack the native copy shortcut.
    fireEvent.keyDown(input, { key: "c", ctrlKey: true });
    expect(writeText).toHaveBeenCalledTimes(1);
    await flushEffects();
  });

  it("Escape closes the Trash panel", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "trash_items") return Promise.resolve([]);
      return Promise.resolve(42);
    });
    useSearchStore.setState({ showTrash: true });
    render(<App />);
    await flushEffects();
    expect(screen.getAllByText("Trash").length).toBeGreaterThan(0);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useSearchStore.getState().showTrash).toBe(false);
  });

  it("About dialog shows the runtime app version, not a hardcoded one", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "plugin:app|version") return Promise.resolve("9.9.9");
      return Promise.resolve(42);
    });
    useSearchStore.setState({ showAbout: true });
    render(<App />);
    await flushEffects();
    expect(screen.getByText(/Version 9\.9\.9/)).toBeInTheDocument();
    expect(screen.queryByText(/Version 0\.1\.0/)).not.toBeInTheDocument();
  });

  it("applies size/date filters to the browse count", async () => {
    const browseSections = [
      {
        category: "Music",
        count: 3,
        files: [
          {
            id: 1,
            title: "small.mp3",
            snippet: "",
            path: "/music/small.mp3",
            relevance: 0,
            size: 1024,
            modified: 0,
            category: "Music",
          },
          {
            id: 2,
            title: "medium.mp3",
            snippet: "",
            path: "/music/medium.mp3",
            relevance: 0,
            size: 50 * 1024 * 1024,
            modified: 0,
            category: "Music",
          },
          {
            id: 3,
            title: "large.mp3",
            snippet: "",
            path: "/music/large.mp3",
            relevance: 0,
            size: 200 * 1024 * 1024,
            modified: 0,
            category: "Music",
          },
        ],
      },
    ];
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "browse_files") return Promise.resolve(browseSections);
      return Promise.resolve(42);
    });
    useSearchStore.setState({
      query: "",
      activeSizeFilter: "Medium (1-100MB)",
      browseSections,
    });
    render(<App />);
    await flushEffects();
    expect(screen.getByText("1 file")).toBeInTheDocument();
    expect(screen.getAllByText("medium.mp3").length).toBeGreaterThan(0);
    expect(screen.queryByText("small.mp3")).not.toBeInTheDocument();
    expect(screen.queryByText("large.mp3")).not.toBeInTheDocument();
  });

  it("clears a selection hidden by a size filter (2.8)", async () => {
    const small: SearchResult = {
      ...selectedResult,
      id: 11,
      title: "small.txt",
      size: 1024,
    };
    const big: SearchResult = {
      ...selectedResult,
      id: 10,
      title: "big.zip",
      size: 500 * 1024 * 1024,
    };
    const rows = [big, small];
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "search_files") return Promise.resolve(rows);
      return Promise.resolve(42);
    });
    useSearchStore.setState({
      query: "report",
      results: rows,
      selectedResult: big,
      activeSizeFilter: "Any Size",
    });
    render(<App />);
    await flushEffects();

    const sizeSelect = screen.getByDisplayValue("Any Size");
    fireEvent.change(sizeSelect, { target: { value: "Small (< 1MB)" } });
    await flushEffects();

    expect(useSearchStore.getState().selectedResult).toBeNull();
  });

  it("disables background running when the licence lacks the feature (2.16)", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "get_license_status")
        return Promise.resolve({
          pro: false,
          plan: "free",
          features: [],
          userId: null,
          issuedAt: null,
          expiresAt: null,
          reason: "none",
          renewable: false,
        });
      if (cmd === "get_entitlements") return Promise.resolve([]);
      return Promise.resolve(42);
    });
    useSearchStore.setState({ runInBackground: true, query: "" });
    useLicenseStore.setState({ status: null, entitlements: [] });
    render(<App />);
    await flushEffects();
    await flushEffects();
    expect(useSearchStore.getState().runInBackground).toBe(false);
  });

  it("context-menu Copy Path copies the row path", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "browse_files") {
        return Promise.resolve([
          { category: "Documents", count: 1, files: [selectedResult] },
        ]);
      }
      return Promise.resolve(42);
    });
    useSearchStore.setState({ browseSections: [], query: "" });
    render(<App />);
    await flushEffects();

    const row = screen.getAllByText("report.pdf")[0].closest("tr");
    expect(row).not.toBeNull();
    fireEvent.contextMenu(row!, { clientX: 12, clientY: 12 });
    const contextItem = screen
      .getAllByText("Copy Path")
      .find((el) => el.className === "menu-dropdown-item");
    expect(contextItem).toBeDefined();
    fireEvent.click(contextItem!);

    expect(writeText).toHaveBeenCalledWith(selectedResult.path);
    expect(messageMock).not.toHaveBeenCalled();
  });

  it("context-menu Copy Path reports a clipboard rejection", async () => {
    const writeText = vi.fn(() => Promise.reject(new Error("denied")));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "browse_files") {
        return Promise.resolve([
          { category: "Documents", count: 1, files: [selectedResult] },
        ]);
      }
      return Promise.resolve(42);
    });
    useSearchStore.setState({ browseSections: [], query: "" });
    render(<App />);
    await flushEffects();

    const row = screen.getAllByText("report.pdf")[0].closest("tr");
    fireEvent.contextMenu(row!, { clientX: 12, clientY: 12 });
    const contextItem = screen
      .getAllByText("Copy Path")
      .find((el) => el.className === "menu-dropdown-item");
    fireEvent.click(contextItem!);
    await flushEffects();

    expect(messageMock).toHaveBeenCalledWith("Could not copy path");
  });
});
