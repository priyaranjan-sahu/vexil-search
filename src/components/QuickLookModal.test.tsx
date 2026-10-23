import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { QuickLookModal } from "./QuickLookModal";
import type { SearchResult } from "../store/searchStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() =>
    Promise.resolve({
      path: "/data/notes.txt",
      title: "notes.txt",
      size: 1024,
      modified: 1700000000,
      is_text: true,
      content: "hello world sample preview content",
      lines_count: 1,
      extension: "txt",
    }),
  ),
}));

const sampleResult: SearchResult = {
  id: 1,
  title: "notes.txt",
  snippet: "hello <b>world</b>",
  path: "/data/notes.txt",
  relevance: 95,
  size: 1024,
  modified: 1700000000,
  category: "Documents",
};

describe("QuickLookModal", () => {
  it("renders preview with title, path, and action buttons", async () => {
    const onClose = vi.fn();
    const onOpen = vi.fn();
    const onReveal = vi.fn();

    await act(async () => {
      render(
        <QuickLookModal
          result={sampleResult}
          onClose={onClose}
          onOpen={onOpen}
          onReveal={onReveal}
        />,
      );
    });

    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByText("/data/notes.txt")).toBeInTheDocument();
    expect(screen.getByText("Reveal in Folder")).toBeInTheDocument();
    expect(screen.getByText("Open File")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Open File"));
    expect(onOpen).toHaveBeenCalledWith(sampleResult);

    fireEvent.click(screen.getByText("Reveal in Folder"));
    expect(onReveal).toHaveBeenCalledWith("/data/notes.txt");
  });

  it("triggers onClose on Escape key", async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(
        <QuickLookModal
          result={sampleResult}
          onClose={onClose}
          onOpen={vi.fn()}
          onReveal={vi.fn()}
        />,
      );
    });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
