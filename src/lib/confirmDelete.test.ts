import { describe, expect, it } from "vitest";
import { confirmDelete, TRASH_RETENTION_DAYS } from "./confirmDelete";

describe("confirmDelete", () => {
  it("names the file so the user can verify the right row", () => {
    const messages: string[] = [];
    window.confirm = (message?: string) => {
      messages.push(message ?? "");
      return true;
    };

    confirmDelete("report.pdf", "/data/report.pdf");

    expect(messages[0]).toContain("report.pdf");
  });

  it("says the file is recoverable rather than gone", () => {
    const messages: string[] = [];
    window.confirm = (message?: string) => {
      messages.push(message ?? "");
      return true;
    };

    confirmDelete("report.pdf", "/data/report.pdf");

    expect(messages[0]).toContain("Trash");
    expect(messages[0]).toContain(`${TRASH_RETENTION_DAYS} days`);
    // The old copy promised a permanent delete that no longer happens.
    expect(messages[0]).not.toContain("cannot be undone");
  });

  it("falls back to the filename when the result has no title", () => {
    const messages: string[] = [];
    window.confirm = (message?: string) => {
      messages.push(message ?? "");
      return true;
    };

    confirmDelete(undefined, "/data/nested/photo.jpg");

    expect(messages[0]).toContain("photo.jpg");
  });

  it("returns the user's answer", () => {
    window.confirm = () => true;
    expect(confirmDelete("a.txt", "/a.txt")).toBe(true);

    window.confirm = () => false;
    expect(confirmDelete("a.txt", "/a.txt")).toBe(false);
  });
});
