import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

export interface UpdateInfo {
  update_available: boolean;
  current_version: string;
  latest_version: string;
  release_url: string;
  notes: string;
  published_at: string;
}

// One check per session: keeps the GitHub API's unauthenticated rate limit
// (60/hour) safe even under React StrictMode's double-invoked effects.
let pendingCheck: Promise<UpdateInfo | null> | null = null;

/**
 * Asks Rust whether a newer release exists. Resolves to `null` whenever the
 * answer is "no", "unknown", or the feed is unreachable — an update check must
 * never surface an error to the user.
 */
export function checkForUpdates(): Promise<UpdateInfo | null> {
  if (!pendingCheck) {
    pendingCheck = invoke<UpdateInfo>("check_for_updates")
      .then((info) => (info && info.update_available ? info : null))
      .catch(() => null);
  }
  return pendingCheck;
}

/** Opens the GitHub release page for `info` in the system browser. */
export async function openReleasePage(info: UpdateInfo): Promise<void> {
  try {
    await openUrl(info.release_url);
  } catch {
    window.open(info.release_url, "_blank", "noopener");
  }
}

/**
 * Desktop path: installs the update in place via tauri-plugin-updater (the
 * app restarts itself when done, so this call usually never resolves).
 * Any failure — including the mobile "not supported" stub — falls back to
 * the release page in the browser.
 */
export async function applyUpdate(info: UpdateInfo): Promise<void> {
  try {
    await invoke("install_update");
  } catch {
    await openReleasePage(info);
  }
}

/**
 * Polls for an update shortly after mount and holds it until dismissed.
 * The delay lets startup work (indexing, license checks) grab the network
 * first, and the session-wide cache makes repeated mounts harmless.
 */
export function useUpdateInfo(delayMs = 4000): {
  info: UpdateInfo | null;
  dismiss: () => void;
} {
  const [info, setInfo] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void checkForUpdates().then((latest) => {
        if (!cancelled && latest) setInfo(latest);
      });
    }, delayMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [delayMs]);

  return { info, dismiss: () => setInfo(null) };
}

/** Test-only: clears the session cache so each test starts fresh. */
export function resetUpdateCheckCache(): void {
  pendingCheck = null;
}
