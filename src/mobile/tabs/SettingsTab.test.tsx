import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useSearchStore } from "../../store/searchStore";
import { SettingsTab } from "./SettingsTab";

const mockInvoke = vi.mocked(invoke);

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

beforeEach(() => {
  useSearchStore.setState({
    theme: "system",
    customDirs: [],
    excludedDirs: [],
  });
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(() => Promise.resolve("started"));
});

afterEach(() => {
  delete (window as unknown as { VexilAndroid?: unknown }).VexilAndroid;
});

describe("SettingsTab", () => {
  it("opens the Android folder picker without toasting before it returns", () => {
    const pickFolder = vi.fn();
    (window as unknown as { VexilAndroid?: unknown }).VexilAndroid = {
      hasAllFilesAccess: () => true,
      openAllFilesAccess: vi.fn(),
      pickFolder,
    };
    const onToast = vi.fn();
    render(
      <SettingsTab
        platform="android"
        allFilesAccess={true}
        roots={[]}
        onRemoveRoot={vi.fn()}
        onReindex={vi.fn()}
        onToast={onToast}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Folder" }));
    expect(pickFolder).toHaveBeenCalledTimes(1);
    expect(onToast).not.toHaveBeenCalled();
  });

  it("toasts only after the iOS importer finishes", async () => {
    mockInvoke.mockResolvedValue("Imported 3 files");
    const onToast = vi.fn();
    render(
      <SettingsTab
        platform="ios"
        allFilesAccess={true}
        roots={[]}
        onRemoveRoot={vi.fn()}
        onReindex={vi.fn()}
        onToast={onToast}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Import Files…" }));
    expect(onToast).not.toHaveBeenCalled();
    await flush();
    expect(onToast).toHaveBeenCalledWith("Imported 3 files");
  });
});
