import { describe, it, expect } from "vitest";
import {
  SHORTCUT_PRESETS,
  formatShortcutForDisplay,
  parseKeyboardEventToShortcut,
} from "./shortcutHelper";

describe("shortcutHelper", () => {
  describe("formatShortcutForDisplay", () => {
    it("formats CommandOrControl+Shift+Space correctly for Windows and Mac", () => {
      const winDisplay = formatShortcutForDisplay(
        "CommandOrControl+Shift+Space",
        false,
      );
      expect(winDisplay).toBe("Ctrl + Shift + Space");

      const macDisplay = formatShortcutForDisplay(
        "CommandOrControl+Shift+Space",
        true,
      );
      expect(macDisplay).toBe("⌘ ⇧ Space");
    });

    it("formats Alt+Space correctly", () => {
      const winDisplay = formatShortcutForDisplay("Alt+Space", false);
      expect(winDisplay).toBe("Alt + Space");

      const macDisplay = formatShortcutForDisplay("Alt+Space", true);
      expect(macDisplay).toBe("⌥ Space");
    });

    it("returns empty string for empty input", () => {
      expect(formatShortcutForDisplay("")).toBe("");
    });
  });

  describe("parseKeyboardEventToShortcut", () => {
    it("returns null for bare modifier key presses", () => {
      expect(
        parseKeyboardEventToShortcut({
          key: "Control",
          code: "ControlLeft",
          ctrlKey: true,
          altKey: false,
          shiftKey: false,
          metaKey: false,
        } as KeyboardEvent),
      ).toBeNull();

      expect(
        parseKeyboardEventToShortcut({
          key: "Shift",
          code: "ShiftLeft",
          ctrlKey: false,
          altKey: false,
          shiftKey: true,
          metaKey: false,
        } as KeyboardEvent),
      ).toBeNull();
    });

    it("returns null when neither modifier nor function key is pressed", () => {
      expect(
        parseKeyboardEventToShortcut({
          key: "a",
          code: "KeyA",
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
          metaKey: false,
        } as KeyboardEvent),
      ).toBeNull();
    });

    it("parses Alt + Space correctly", () => {
      const result = parseKeyboardEventToShortcut({
        key: " ",
        code: "Space",
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
        metaKey: false,
      } as KeyboardEvent);

      expect(result).not.toBeNull();
      expect(result?.accelerator).toBe("Alt+Space");
    });

    it("parses Ctrl + Shift + F correctly", () => {
      const result = parseKeyboardEventToShortcut({
        key: "f",
        code: "KeyF",
        ctrlKey: true,
        altKey: false,
        shiftKey: true,
        metaKey: false,
      } as KeyboardEvent);

      expect(result).not.toBeNull();
      expect(result?.accelerator).toBe("CommandOrControl+Shift+F");
    });

    it("allows function keys (e.g. F12) without modifiers", () => {
      const result = parseKeyboardEventToShortcut({
        key: "F12",
        code: "F12",
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: false,
      } as KeyboardEvent);

      expect(result).not.toBeNull();
      expect(result?.accelerator).toBe("F12");
    });
  });

  describe("SHORTCUT_PRESETS", () => {
    it("contains popular shortcuts including Alt+Space and CommandOrControl+Shift+Space", () => {
      expect(SHORTCUT_PRESETS.length).toBeGreaterThanOrEqual(4);
      const accelerators = SHORTCUT_PRESETS.map((p) => p.accelerator);
      expect(accelerators).toContain("Alt+Space");
      expect(accelerators).toContain("CommandOrControl+Shift+Space");
    });
  });
});
