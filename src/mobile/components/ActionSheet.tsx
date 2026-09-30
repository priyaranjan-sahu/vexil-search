export interface ActionSheetAction {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

/** Bottom sheet with a scrim; actions are full-width with ≥48px touch targets. */
export const ActionSheet = ({
  open,
  title,
  actions,
  onClose,
}: {
  open: boolean;
  title?: string;
  actions: ActionSheetAction[];
  onClose: () => void;
}) => {
  if (!open) return null;

  return (
    <div className="mob-sheet-overlay" onClick={onClose} role="presentation">
      <div
        className="mob-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title ?? "Actions"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mob-sheet-handle" />
        {title && <div className="mob-sheet-title">{title}</div>}
        <div className="mob-sheet-body">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={`mob-sheet-action${action.danger ? " danger" : ""}`}
              onClick={() => {
                action.onSelect();
                onClose();
              }}
            >
              {action.label}
            </button>
          ))}
          <button
            type="button"
            className="mob-sheet-action cancel"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};
