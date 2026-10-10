import { describe, expect, it, vi } from "vitest";

const confirmMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: confirmMock }));

import { confirmDelete, TRASH_RETENTION_DAYS } from "./confirmDelete";

describe("confirmDelete", () => {
  it("names the file so the user can verify the right row", async () => {
    const messages: string[] = [];
    confirmMock.mockImplementation((m: string) => {
      messages.push(m);
      return Promise.resolve(true);
    });

    await confirmDelete("report.pdf", "/data/report.pdf");

    expect(messages[0]).toContain("report.pdf");
  });

  it("says the file is recoverable rather than gone", async () => {
    const messages: string[] = [];
    confirmMock.mockImplementation((m: string) => {
      messages.push(m);
      return Promise.resolve(true);
    });

    await confirmDelete("report.pdf", "/data/report.pdf");

    expect(messages[0]).toContain("Trash");
    expect(messages[0]).toContain(`${TRASH_RETENTION_DAYS} days`);
    // The old copy promised a permanent delete that no longer happens.
    expect(messages[0]).not.toContain("cannot be undone");
  });

  it("falls back to the filename when the result has no title", async () => {
    const messages: string[] = [];
    confirmMock.mockImplementation((m: string) => {
      messages.push(m);
      return Promise.resolve(true);
    });

    await confirmDelete(undefined, "/data/nested/photo.jpg");

    expect(messages[0]).toContain("photo.jpg");
  });

  it("returns the user's answer", async () => {
    confirmMock.mockResolvedValue(true);
    expect(await confirmDelete("a.txt", "/a.txt")).toBe(true);

    confirmMock.mockResolvedValue(false);
    expect(await confirmDelete("a.txt", "/a.txt")).toBe(false);
  });
});
