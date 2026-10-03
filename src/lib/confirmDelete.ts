/**
 * Single confirmation gate for the destructive delete action.
 *
 * `delete_file` calls `fs::remove_file` with no undo and no recycle bin, so a
 * mis-tap destroys the file permanently. Both the desktop toolbar button and the
 * mobile action sheet route through here so neither platform can skip it.
 *
 * The filename is included so the user can confirm they picked the right row
 * before the row disappears.
 */
export const confirmDelete = (
  title: string | undefined,
  path: string,
): boolean => {
  const name = title || path.split(/[\\/]/).pop() || "this file";
  return window.confirm(
    `Permanently delete "${name}"?\n\nThis cannot be undone.`,
  );
};
