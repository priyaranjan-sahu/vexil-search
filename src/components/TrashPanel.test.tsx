import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TrashPanel } from "./TrashPanel";

const mockInvoke = vi.mocked(invoke);
const confirmMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: confirmMock }));

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

const items = [
  {
    id: 1,
    name: "tax return.pdf",
    original_path: "/storage/emulated/0/Documents/tax return.pdf",
    size_bytes: 2048,
    deleted_at: 1_700_000_000,
    days_left: 30,
  },
  {
    id: 2,
    name: "old photo.jpg",
    original_path: "/storage/emulated/0/DCIM/old photo.jpg",
    size_bytes: 1024 * 1024 * 3,
    deleted_at: 1_699_000_000,
    days_left: 12,
  },
];

beforeEach(() => {
  mockInvoke.mockReset();
  confirmMock.mockReset();
  mockInvoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "trash_items":
        return Promise.resolve(items);
      case "restore_trashed_file":
        return Promise.resolve("/storage/emulated/0/Documents/tax return.pdf");
      case "empty_trash":
        return Promise.resolve("2 files permanently deleted");
      default:
        return Promise.resolve(undefined);
    }
  });
});

describe("TrashPanel", () => {
  it("lists trashed files with their original location", async () => {
    render(<TrashPanel onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText("tax return.pdf")).toBeInTheDocument(),
    );

    expect(screen.getByText("old photo.jpg")).toBeInTheDocument();
    // The path is what tells two same-named files apart.
    expect(
      screen.getByText("/storage/emulated/0/DCIM/old photo.jpg"),
    ).toBeInTheDocument();
  });

  it("shows how long each file stays restorable", async () => {
    render(<TrashPanel onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText(/30 days left/)).toBeInTheDocument(),
    );

    expect(screen.getByText(/12 days left/)).toBeInTheDocument();
    // 3 MB is formatted rather than shown as raw bytes.
    expect(screen.getByText(/3\.0 MB/)).toBeInTheDocument();
  });

  it("restores the chosen file and reports where it went", async () => {
    const onChanged = vi.fn();
    render(<TrashPanel onClose={() => {}} onChanged={onChanged} />);
    await waitFor(() =>
      expect(screen.getByText("tax return.pdf")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Restore" })[0]);
    await flush();

    expect(mockInvoke).toHaveBeenCalledWith("restore_trashed_file", { id: 1 });
    expect(onChanged).toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.getByText(/Restored to \/storage\/emulated\/0\/Documents/),
      ).toBeInTheDocument(),
    );
  });

  it("only restores one file, never the whole trash", async () => {
    render(<TrashPanel onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText("tax return.pdf")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Restore" })[1]);
    await flush();

    expect(mockInvoke).toHaveBeenCalledWith("restore_trashed_file", { id: 2 });
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "empty_trash",
      expect.anything(),
    );
  });

  it("asks before emptying, and does nothing if declined", async () => {
    confirmMock.mockResolvedValue(false);
    const onChanged = vi.fn();
    render(<TrashPanel onClose={() => {}} onChanged={onChanged} />);
    await waitFor(() =>
      expect(screen.getByText("tax return.pdf")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Empty Trash/ }));
    await flush();

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "empty_trash",
      expect.anything(),
    );
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("warns that emptying cannot be undone, then clears the trash", async () => {
    const confirmMessages: string[] = [];
    confirmMock.mockImplementation((m: string) => {
      confirmMessages.push(m);
      return Promise.resolve(true);
    });
    const onChanged = vi.fn();
    render(<TrashPanel onClose={() => {}} onChanged={onChanged} />);
    await waitFor(() =>
      expect(screen.getByText("tax return.pdf")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Empty Trash/ }));
    await flush();

    expect(confirmMessages[0]).toContain("2 files");
    expect(mockInvoke).toHaveBeenCalledWith("empty_trash");
    expect(onChanged).toHaveBeenCalled();
  });

  it("surfaces a failure instead of pretending the restore worked", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "trash_items") return Promise.resolve(items);
      if (cmd === "restore_trashed_file") {
        return Promise.reject("that file is no longer in the trash");
      }
      return Promise.resolve(undefined);
    });

    render(<TrashPanel onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText("tax return.pdf")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Restore" })[0]);
    await flush();

    await waitFor(() =>
      expect(screen.getByText(/Could not restore/)).toBeInTheDocument(),
    );
    // The entry stays listed so the user can see it is still there.
    expect(screen.getByText("tax return.pdf")).toBeInTheDocument();
  });

  it("says so when the trash is empty", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "trash_items" ? Promise.resolve([]) : Promise.resolve(undefined),
    );

    render(<TrashPanel onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText("Trash is empty")).toBeInTheDocument(),
    );

    expect(screen.getByRole("button", { name: /Empty Trash/ })).toBeDisabled();
  });

  it("closes when the backdrop is clicked but not the panel itself", async () => {
    const onClose = vi.fn();
    const { container } = render(<TrashPanel onClose={onClose} />);
    await waitFor(() =>
      expect(screen.getByText("tax return.pdf")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText("tax return.pdf"));
    expect(onClose).not.toHaveBeenCalled();

    const backdrop = container.querySelector(".settings-overlay");
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalled();
  });
});
