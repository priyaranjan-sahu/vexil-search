import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ShortcutRecorder } from "./ShortcutRecorder";

describe("ShortcutRecorder Component", () => {
  it("renders current active shortcut keycap", () => {
    render(
      <ShortcutRecorder
        currentShortcut="Alt+Space"
        onSaveShortcut={() => {}}
      />,
    );

    expect(screen.getByText("Active Toggle Hotkey")).toBeInTheDocument();
    expect(screen.getAllByText("Alt + Space").length).toBeGreaterThanOrEqual(1);
  });

  it("toggles recording mode when clicking record button", () => {
    render(
      <ShortcutRecorder
        currentShortcut="Alt+Space"
        onSaveShortcut={() => {}}
      />,
    );

    const recordBtn = screen.getByRole("button", {
      name: /Record Custom Hotkey/i,
    });
    fireEvent.click(recordBtn);

    expect(
      screen.getByText(/Press keys on keyboard... \(Esc to cancel\)/i),
    ).toBeInTheDocument();
  });

  it("cancels recording when pressing Escape", () => {
    render(
      <ShortcutRecorder
        currentShortcut="Alt+Space"
        onSaveShortcut={() => {}}
      />,
    );

    const recordBtn = screen.getByRole("button", {
      name: /Record Custom Hotkey/i,
    });
    fireEvent.click(recordBtn);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(
      screen.getByRole("button", { name: /Record Custom Hotkey/i }),
    ).toBeInTheDocument();
  });

  it("captures valid key combo and calls onSaveShortcut", () => {
    const onSave = vi.fn();
    render(
      <ShortcutRecorder currentShortcut="Alt+Space" onSaveShortcut={onSave} />,
    );

    const recordBtn = screen.getByRole("button", {
      name: /Record Custom Hotkey/i,
    });
    fireEvent.click(recordBtn);

    fireEvent.keyDown(window, {
      key: "f",
      code: "KeyF",
      ctrlKey: true,
      shiftKey: true,
    });

    expect(onSave).toHaveBeenCalledWith("CommandOrControl+Shift+F");
  });

  it("shows error when a key without modifiers is pressed during recording", () => {
    const onSave = vi.fn();
    render(
      <ShortcutRecorder currentShortcut="Alt+Space" onSaveShortcut={onSave} />,
    );

    const recordBtn = screen.getByRole("button", {
      name: /Record Custom Hotkey/i,
    });
    fireEvent.click(recordBtn);

    fireEvent.keyDown(window, {
      key: "g",
      code: "KeyG",
      ctrlKey: false,
      altKey: false,
    });

    expect(
      screen.getByText(/Include at least one modifier key/i),
    ).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("selects a popular preset shortcut on click", () => {
    const onSave = vi.fn();
    render(
      <ShortcutRecorder currentShortcut="Alt+Space" onSaveShortcut={onSave} />,
    );

    const presetBtn = screen.getByRole("button", {
      name: /Alt \+ F/i,
    });
    fireEvent.click(presetBtn);

    expect(onSave).toHaveBeenCalledWith("Alt+F");
  });
});
