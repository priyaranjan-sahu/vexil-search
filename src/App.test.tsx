import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import App from "./App";

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

describe("App Component", () => {
  it("renders the search input", () => {
    render(<App />);
    const searchInput = screen.getByPlaceholderText(
      /search documents, apps, files/i,
    );
    expect(searchInput).toBeInTheDocument();
  });

  it("updates category filter when a filter button is clicked", () => {
    render(<App />);
    const imagesBtn = screen.getByText("Images");
    fireEvent.click(imagesBtn);
    expect(imagesBtn).toHaveClass("active");
  });
});
