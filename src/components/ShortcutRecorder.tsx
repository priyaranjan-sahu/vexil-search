import React, { useState, useEffect, useRef } from "react";
import {
  SHORTCUT_PRESETS,
  formatShortcutForDisplay,
  parseKeyboardEventToShortcut,
} from "../lib/shortcutHelper";

interface ShortcutRecorderProps {
  currentShortcut: string;
  onSaveShortcut: (newShortcut: string) => Promise<boolean> | boolean | void;
  statusMessage?: string | null;
}

export const ShortcutRecorder: React.FC<ShortcutRecorderProps> = ({
  currentShortcut,
  onSaveShortcut,
  statusMessage,
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const recorderButtonRef = useRef<HTMLButtonElement | null>(null);

  // Focus recorder button when recording starts
  useEffect(() => {
    if (isRecording && recorderButtonRef.current) {
      recorderButtonRef.current.focus();
    }
  }, [isRecording]);

  useEffect(() => {
    if (!isRecording) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        setIsRecording(false);
        setErrorMsg(null);
        return;
      }

      const result = parseKeyboardEventToShortcut(e);
      if (!result) {
        setErrorMsg(
          "Include at least one modifier key (Ctrl, Alt, Shift, or Cmd)",
        );
        return;
      }

      setErrorMsg(null);
      setIsRecording(false);

      // Auto-save the recorded shortcut
      try {
        const res = onSaveShortcut(result.accelerator);
        if (res !== false) {
          setSuccessMsg(`Shortcut updated to ${result.display}`);
          setTimeout(() => setSuccessMsg(null), 3000);
        }
      } catch (err) {
        setErrorMsg(
          err instanceof Error ? err.message : "Failed to register shortcut",
        );
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [isRecording, onSaveShortcut]);

  const handleSelectPreset = (accelerator: string, label: string) => {
    setErrorMsg(null);
    try {
      const res = onSaveShortcut(accelerator);
      if (res !== false) {
        setSuccessMsg(`Shortcut set to ${label}`);
        setTimeout(() => setSuccessMsg(null), 3000);
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Failed to set shortcut",
      );
    }
  };

  return (
    <div className="shortcut-recorder-container">
      <div className="shortcut-current-box">
        <div className="shortcut-current-left">
          <span className="shortcut-label">Active Toggle Hotkey</span>
          <div className="shortcut-active-keycap-wrapper">
            <kbd className="shortcut-keycap">
              <span className="keycap-icon">⌘</span>
              {formatShortcutForDisplay(currentShortcut)}
            </kbd>
            <span className="shortcut-hint">
              Press anywhere in Windows/macOS to summon Vexil
            </span>
          </div>
        </div>

        <button
          ref={recorderButtonRef}
          type="button"
          className={`shortcut-record-btn ${isRecording ? "recording" : ""}`}
          onClick={() => {
            setErrorMsg(null);
            setIsRecording(!isRecording);
          }}
        >
          {isRecording ? (
            <span className="recording-pulse-wrapper">
              <span className="recording-dot"></span>
              Press keys on keyboard... (Esc to cancel)
            </span>
          ) : (
            <span>⌨️ Record Custom Hotkey</span>
          )}
        </button>
      </div>

      {isRecording && (
        <div className="shortcut-recording-overlay">
          <div className="recording-instruction">
            Press any key combination on your keyboard (e.g.,{" "}
            <strong>Alt + Space</strong>, <strong>Ctrl + Shift + F</strong>)
          </div>
        </div>
      )}

      {errorMsg && <div className="shortcut-status-error">{errorMsg}</div>}
      {successMsg && (
        <div className="shortcut-status-success">{successMsg}</div>
      )}
      {statusMessage && !errorMsg && !successMsg && (
        <div className="shortcut-status-info">{statusMessage}</div>
      )}

      {/* Quick Preset Selector */}
      <div className="shortcut-presets-section">
        <span className="presets-title">Popular Preset Hotkeys</span>
        <div className="shortcut-presets-list">
          {SHORTCUT_PRESETS.map((preset) => {
            const isSelected = currentShortcut === preset.accelerator;
            return (
              <button
                key={preset.id}
                type="button"
                className={`shortcut-preset-pill ${isSelected ? "selected" : ""}`}
                onClick={() =>
                  handleSelectPreset(preset.accelerator, preset.label)
                }
                title={preset.description}
              >
                <span className="preset-label">{preset.label}</span>
                {isSelected && <span className="preset-badge">Active</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
