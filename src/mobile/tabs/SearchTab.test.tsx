import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSearchStore } from "../../store/searchStore";
import { SearchTab } from "./SearchTab";

beforeEach(() => {
  useSearchStore.setState({
    query: "",
    results: [],
    myPicks: [],
    activeCategory: "All",
    activeSizeFilter: "Any Size",
    activeDateFilter: "Any Time",
    indexingProgress: null,
  });
});

describe("SearchTab", () => {
  it("renders the category chips with All active by default", () => {
    render(<SearchTab onLongPress={vi.fn()} />);
    const allChip = screen.getByRole("button", { name: "All" });
    expect(allChip).toHaveClass("active");
    expect(screen.getByRole("button", { name: "Images" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Folder" })).toBeInTheDocument();
  });

  it("toggles the active category on chip click and updates the store", () => {
    render(<SearchTab onLongPress={vi.fn()} />);
    const images = screen.getByRole("button", { name: "Images" });
    fireEvent.click(images);
    expect(images).toHaveClass("active");
    expect(useSearchStore.getState().activeCategory).toBe("Images");
  });

  it("renders size and date filter chips", () => {
    render(<SearchTab onLongPress={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Medium (1-100MB)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "This Week" }),
    ).toBeInTheDocument();
  });

  it("shows the empty hint when there is no query", () => {
    render(<SearchTab onLongPress={vi.fn()} />);
    expect(
      screen.getByText("Start typing to search your files"),
    ).toBeInTheDocument();
  });

  it("lists matching results", () => {
    useSearchStore.setState({
      results: [
        {
          id: 1,
          title: "song.mp3",
          snippet: "music",
          path: "/music/song.mp3",
          relevance: 90,
          size: 4000,
          modified: 0,
          category: "Music",
        },
      ],
    });
    render(<SearchTab onLongPress={vi.fn()} />);
    expect(screen.getByText("song.mp3")).toBeInTheDocument();
  });
});
