import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ResultCard } from "./ResultCard";

const result = {
  id: 1,
  title: "report.pdf",
  snippet: "matched",
  path: "/docs/report.pdf",
  relevance: 88,
  size: 2048,
  modified: 1700000000,
  category: "Documents",
};

describe("ResultCard", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens the result on a quick tap", () => {
    const onOpen = vi.fn();
    render(
      <ResultCard
        result={result}
        isPinned={false}
        onOpen={onOpen}
        onLongPress={vi.fn()}
      />,
    );
    const card = screen.getByText("report.pdf");
    fireEvent.pointerDown(card, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(card);
    fireEvent.click(card);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("opens the action sheet on a long press (>=500ms)", () => {
    const onLongPress = vi.fn();
    render(
      <ResultCard
        result={result}
        isPinned={false}
        onOpen={vi.fn()}
        onLongPress={onLongPress}
      />,
    );
    const card = screen.getByText("report.pdf");
    fireEvent.pointerDown(card, { clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(onLongPress).toHaveBeenCalledWith(result);

    // A tap right after a long press must not also open the file.
    fireEvent.pointerUp(card);
    fireEvent.click(card);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("cancels the long press when the finger moves more than 10px", () => {
    const onLongPress = vi.fn();
    render(
      <ResultCard
        result={result}
        isPinned={false}
        onOpen={vi.fn()}
        onLongPress={onLongPress}
      />,
    );
    const card = screen.getByText("report.pdf");
    fireEvent.pointerDown(card, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(card, { clientX: 40, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("opens the action sheet via context menu (desktop-emulated fallback)", () => {
    const onLongPress = vi.fn();
    render(
      <ResultCard
        result={result}
        isPinned={false}
        onOpen={vi.fn()}
        onLongPress={onLongPress}
      />,
    );
    const card = screen.getByText("report.pdf");
    fireEvent.contextMenu(card);
    expect(onLongPress).toHaveBeenCalledWith(result);
  });

  it("shows the pin marker when pinned", () => {
    render(
      <ResultCard
        result={result}
        isPinned
        onOpen={vi.fn()}
        onLongPress={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Pinned")).toBeInTheDocument();
  });

  it("shows the year on dates from a previous year", () => {
    const old = { ...result, modified: 1546300800 }; // 2019-01-01
    render(
      <ResultCard
        result={old}
        isPinned={false}
        onOpen={vi.fn()}
        onLongPress={vi.fn()}
      />,
    );
    expect(screen.getByText(/2019/)).toBeInTheDocument();
  });

  it("omits the year for dates in the current year", () => {
    const now = Math.floor(Date.now() / 1000);
    const recent = { ...result, modified: now };
    render(
      <ResultCard
        result={recent}
        isPinned={false}
        onOpen={vi.fn()}
        onLongPress={vi.fn()}
      />,
    );
    const meta = screen.getByText(/Documents/).textContent ?? "";
    expect(meta).not.toMatch(/\b20\d\d\b/);
  });
});
