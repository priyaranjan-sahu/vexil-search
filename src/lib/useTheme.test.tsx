import { render, act } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { useSearchStore } from "../store/searchStore";
import { useThemeSync } from "./useTheme";

function Harness() {
  useThemeSync();
  return null;
}

beforeEach(() => {
  useSearchStore.setState({ theme: "system" });
  document.documentElement.className = "";
});

describe("useThemeSync", () => {
  it("applies the dark class when theme is dark and removes light", () => {
    useSearchStore.setState({ theme: "dark" });
    render(<Harness />);
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement).not.toHaveClass("light");
  });

  it("applies the light class when theme is light", () => {
    useSearchStore.setState({ theme: "light" });
    render(<Harness />);
    expect(document.documentElement).toHaveClass("light");
    expect(document.documentElement).not.toHaveClass("dark");
  });

  it("keeps the class list empty for the system theme", () => {
    render(<Harness />);
    expect(document.documentElement).not.toHaveClass("light");
    expect(document.documentElement).not.toHaveClass("dark");
  });

  it("reacts to a theme change after mount", () => {
    render(<Harness />);
    act(() => useSearchStore.setState({ theme: "dark" }));
    expect(document.documentElement).toHaveClass("dark");
  });
});
