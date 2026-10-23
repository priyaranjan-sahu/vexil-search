import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { DuplicateFinderModal } from "./DuplicateFinderModal";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "find_duplicates") {
      return Promise.resolve([
        {
          hash: "abc12345",
          size: 2048,
          wasted_bytes: 2048,
          files: [
            {
              id: 1,
              path: "/docs/original.txt",
              title: "original.txt",
              size: 2048,
              modified: 1700000000,
              category: "Documents",
            },
            {
              id: 2,
              path: "/downloads/copy.txt",
              title: "copy.txt",
              size: 2048,
              modified: 1700000100,
              category: "Documents",
            },
          ],
        },
      ]);
    }
    return Promise.resolve();
  }),
}));

describe("DuplicateFinderModal", () => {
  it("renders duplicate groups with file names and reclaimable space", async () => {
    const onClose = vi.fn();
    const onOpen = vi.fn();
    const onReveal = vi.fn();
    const onDelete = vi.fn().mockResolvedValue(undefined);

    await act(async () => {
      render(
        <DuplicateFinderModal
          isOpen={true}
          onClose={onClose}
          onOpen={onOpen}
          onReveal={onReveal}
          onDelete={onDelete}
        />,
      );
    });

    expect(screen.getByText("Duplicate File Finder")).toBeInTheDocument();
    expect(screen.getByText("original.txt")).toBeInTheDocument();
    expect(screen.getByText("copy.txt")).toBeInTheDocument();
    expect(screen.getByText("Select All Except Newest")).toBeInTheDocument();
  });

  it("selects duplicate copies when clicking Select All Except Newest", async () => {
    const onClose = vi.fn();

    await act(async () => {
      render(
        <DuplicateFinderModal
          isOpen={true}
          onClose={onClose}
          onOpen={vi.fn()}
          onReveal={vi.fn()}
          onDelete={vi.fn()}
        />,
      );
    });

    const selectBtn = screen.getByText("Select All Except Newest");
    fireEvent.click(selectBtn);

    // Oldest copy is /docs/original.txt so it gets selected
    expect(screen.getByText("Delete Selected (1)")).toBeInTheDocument();
  });
});
