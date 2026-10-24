/**
 * Global Shortcut Helper for Desktop App.
 * Converts keyboard events to Tauri accelerator format and provides human-readable display strings.
 */

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform + navigator.userAgent);

export interface ShortcutPreset {
  id: string;
  label: string;
  accelerator: string;
  description: string;
}

export const SHORTCUT_PRESETS: ShortcutPreset[] = [
  {
    id: "alt-space",
    label: "Alt + Space",
    accelerator: "Alt+Space",
    description: "Spotlight / PowerToys Run style (Fastest)",
  },
  {
    id: "default",
    label: isMac ? "⌘ + ⇧ + Space" : "Ctrl + Shift + Space",
    accelerator: "CommandOrControl+Shift+Space",
    description: "Default standard toggle",
  },
  {
    id: "ctrl-space",
    label: isMac ? "⌘ + Space" : "Ctrl + Space",
    accelerator: "CommandOrControl+Space",
    description: "Minimal modifier toggle",
  },
  {
    id: "ctrl-shift-f",
    label: isMac ? "⌘ + ⇧ + F" : "Ctrl + Shift + F",
    accelerator: "CommandOrControl+Shift+F",
    description: "Global Find hotkey",
  },
  {
    id: "alt-f",
    label: "Alt + F",
    accelerator: "Alt+F",
    description: "Quick Search shortcut",
  },
];

/**
 * Formats a Tauri accelerator string for user-friendly display.
 * e.g. "CommandOrControl+Shift+Space" -> "Ctrl + Shift + Space" (Windows) or "⌘ + ⇧ + Space" (Mac)
 */
export function formatShortcutForDisplay(
  accelerator: string,
  mac: boolean = isMac,
): string {
  if (!accelerator) return "";

  const parts = accelerator.split("+").map((p) => p.trim());
  const formattedParts = parts.map((part) => {
    const lower = part.toLowerCase();
    if (lower === "commandorcontrol" || lower === "cmdorctrl") {
      return mac ? "⌘" : "Ctrl";
    }
    if (lower === "control" || lower === "ctrl") {
      return mac ? "⌃" : "Ctrl";
    }
    if (lower === "alt" || lower === "option") {
      return mac ? "⌥" : "Alt";
    }
    if (lower === "shift") {
      return mac ? "⇧" : "Shift";
    }
    if (
      lower === "super" ||
      lower === "meta" ||
      lower === "command" ||
      lower === "cmd"
    ) {
      return mac ? "⌘" : "Win";
    }
    if (lower === "space") {
      return "Space";
    }
    return part.toUpperCase();
  });

  return formattedParts.join(mac ? " " : " + ");
}

/**
 * Converts a browser KeyboardEvent into a Tauri accelerator string and display format.
 * Returns null if the pressed key is only a modifier or invalid.
 */
export function parseKeyboardEventToShortcut(
  e: KeyboardEvent | React.KeyboardEvent,
): { accelerator: string; display: string } | null {
  const key = e.key;

  // Ignore bare modifier presses
  if (
    key === "Control" ||
    key === "Shift" ||
    key === "Alt" ||
    key === "Meta" ||
    key === "CapsLock"
  ) {
    return null;
  }

  // Must have at least one modifier key OR be a Function key (F1-F12)
  const isFunctionKey = /^F([1-9]|1[0-2])$/i.test(key);
  const hasModifier = e.ctrlKey || e.altKey || e.shiftKey || e.metaKey;

  if (!hasModifier && !isFunctionKey) {
    return null;
  }

  const modifiers: string[] = [];

  // Use CommandOrControl for portability unless Alt/Ctrl specifically pressed
  if (e.ctrlKey && e.metaKey) {
    modifiers.push("Control");
    modifiers.push("Super");
  } else if (e.ctrlKey || e.metaKey) {
    modifiers.push("CommandOrControl");
  }

  if (e.altKey) {
    modifiers.push("Alt");
  }

  if (e.shiftKey) {
    modifiers.push("Shift");
  }

  let primaryKey = key;
  if (primaryKey === " " || e.code === "Space") {
    primaryKey = "Space";
  } else if (primaryKey.length === 1) {
    primaryKey = primaryKey.toUpperCase();
  } else if (primaryKey.startsWith("Arrow")) {
    primaryKey = primaryKey.replace("Arrow", "");
  }

  const accelerator = [...modifiers, primaryKey].join("+");
  const display = formatShortcutForDisplay(accelerator);

  return { accelerator, display };
}
