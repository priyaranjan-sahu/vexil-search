import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSearchStore } from "../../store/searchStore";
import { SearchTab } from "./SearchTab";

beforeEach(() => {
  useSearchStore.setState({
    query: "",
    results: [],
    browseSections: [],
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
      screen.getByText(/No files indexed yet\. Add a folder in Settings/),
    ).toBeInTheDocument();
  });

  it("lists matching results", () => {
    useSearchStore.setState({
      query: "song",
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

  it("renders browse sections with counts when no query is entered", () => {
    useSearchStore.setState({
      query: "",
      browseSections: [
        {
          category: "Images",
          count: 5,
          files: [
            {
              id: 1,
              title: "photo.jpg",
              snippet: "",
              path: "/home/photos/photo.jpg",
              relevance: 0,
              size: 1024,
              modified: 1000,
              category: "Images",
            },
          ],
        },
      ],
    });
    render(<SearchTab onLongPress={vi.fn()} />);
    expect(screen.getByText(/Browsing by category/)).toBeInTheDocument();
    expect(screen.getByText("5 files · 1 latest")).toBeInTheDocument();
    expect(screen.getByText("photo.jpg")).toBeInTheDocument();
  });

  it("hides search results while browsing categories", () => {
    useSearchStore.setState({
      query: "",
      browseSections: [],
      results: [
        {
          id: 7,
          title: "report.pdf",
          snippet: "text",
          path: "/docs/report.pdf",
          relevance: 80,
          size: 2048,
          modified: 0,
          category: "Documents",
        },
      ],
    });
    render(<SearchTab onLongPress={vi.fn()} />);
    expect(screen.queryByText("report.pdf")).not.toBeInTheDocument();
    expect(screen.getByText(/No files indexed yet/)).toBeInTheDocument();
  });

  it("applies size/date filters to the browse count", () => {
    useSearchStore.setState({
      query: "",
      activeSizeFilter: "Medium (1-100MB)",
      browseSections: [
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
      ],
    });
    render(<SearchTab onLongPress={vi.fn()} />);
    expect(screen.getByText("1 file")).toBeInTheDocument();
    expect(screen.getByText("medium.mp3")).toBeInTheDocument();
    expect(screen.queryByText("small.mp3")).not.toBeInTheDocument();
    expect(screen.queryByText("large.mp3")).not.toBeInTheDocument();
  });
});
