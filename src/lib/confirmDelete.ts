/**
 * Single confirmation gate for the destructive delete action.
 *
 * Both the desktop toolbar button and the mobile action sheet route through
 * here so neither platform can skip it.
 *
 * The filename is included so the user can confirm they picked the right row
 * before the row disappears, and the copy says the file is recoverable rather
 * than gone: `delete_file` moves the file into Vexil's own trash, which is
 * restorable for 30 days.
 */
export const TRASH_RETENTION_DAYS = 30;

export const confirmDelete = (
  title: string | undefined,
  path: string,
): boolean => {
  const name = title || path.split(/[\\/]/).pop() || "this file";
  return window.confirm(
    `Move "${name}" to Trash?\n\nYou can restore it from Trash for ${TRASH_RETENTION_DAYS} days.`,
  );
};
