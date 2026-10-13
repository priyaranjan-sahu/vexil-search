import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ResultsTable } from "./ResultsTable";
import type { SearchResult } from "../store/searchStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn() }));

const row = (id: number): SearchResult => ({
  id,
  title: `file${id}.txt`,
  snippet: "",
  path: `/data/file${id}.txt`,
  relevance: 90,
  size: 1024,
  modified: 0,
  category: "Documents",
});

const baseProps = {
  filteredResults: [row(1)],
  selectedResult: null,
  setSelectedResult: vi.fn(),
  setContextMenu: vi.fn(),
};

describe("ResultsTable pagination (2.7)", () => {
  it("hides the load-more control when every result is showing", () => {
    render(<ResultsTable {...baseProps} searchTotal={1} hasMore={false} />);
    expect(screen.queryByText(/Load more/)).not.toBeInTheDocument();
  });

  it("shows how many of the total are loaded and loads more on click", () => {
    const onLoadMore = vi.fn();
    render(
      <ResultsTable
        {...baseProps}
        searchTotal={80}
        hasMore
        onLoadMore={onLoadMore}
      />,
    );

    const button = screen.getByText(/Load more \(1 of 80\)/);
    fireEvent.click(button);

    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
