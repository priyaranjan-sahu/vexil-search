import type { UpdateInfo } from "../lib/updates";

interface UpdateBannerProps {
  info: UpdateInfo;
  /** "Update" on platforms that can install in place, "Download" elsewhere. */
  actionLabel: string;
  onAction: () => void;
  onDismiss: () => void;
}

/**
 * Slim "new version available" strip shared by the desktop and mobile shells.
 * Lives in both layouts, so styling is defined once in index.css.
 */
export const UpdateBanner = ({
  info,
  actionLabel,
  onAction,
  onDismiss,
}: UpdateBannerProps) => (
  <div className="update-banner" role="status" data-testid="update-banner">
    <span className="update-banner-text">
      Update available: v{info.latest_version}
      <span className="update-banner-sub">
        {" "}
        (you have v{info.current_version})
      </span>
    </span>
    <span className="update-banner-actions">
      <button
        type="button"
        className="update-banner-btn update-banner-btn-primary"
        onClick={onAction}
      >
        {actionLabel}
      </button>
      <button type="button" className="update-banner-btn" onClick={onDismiss}>
        Later
      </button>
    </span>
  </div>
);
