import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ActionSheet } from "./ActionSheet";

const actions = [
  { label: "Open", onSelect: vi.fn() },
  { label: "Delete", danger: true, onSelect: vi.fn() },
];

describe("ActionSheet", () => {
  it("renders nothing when closed", () => {
    render(<ActionSheet open={false} actions={actions} onClose={vi.fn()} />);
    expect(screen.queryByText("Open")).not.toBeInTheDocument();
  });

  it("renders all actions and the cancel button when open", () => {
    render(<ActionSheet open actions={actions} onClose={vi.fn()} />);
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("marks danger actions", () => {
    const { container } = render(
      <ActionSheet open actions={actions} onClose={vi.fn()} />,
    );
    const deleteBtn = container.querySelector(
      ".mob-sheet-action.danger",
    ) as HTMLButtonElement;
    expect(deleteBtn).not.toBeNull();
    expect(deleteBtn.textContent).toBe("Delete");
  });

  it("invokes the action and closes on select", () => {
    const onClose = vi.fn();
    render(<ActionSheet open actions={actions} onClose={onClose} />);
    fireEvent.click(screen.getByText("Open"));
    expect(actions[0].onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes via the cancel button", () => {
    const onClose = vi.fn();
    render(<ActionSheet open actions={actions} onClose={onClose} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
