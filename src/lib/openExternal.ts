import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openFileWithAndroid } from "../mobile/native";

/**
 * Opens a file in the platform's default handler (video player, image viewer,
 * PDF reader, ...) and reports failures instead of swallowing them.
 *
 * The plugin's own `openPath` is not used: its `opener` scope is empty in
 * `tauri.conf.json` so every call is rejected as `ForbiddenPath`, and on
 * Android/iOS the plugin only forwards URLs to `ACTION_VIEW`/`UIApplication`,
 * which cannot handle a filesystem path.
 */
export async function openFileExternally(path: string): Promise<string | null> {
  const androidError = openFileWithAndroid(path);
  if (androidError !== undefined) {
    return androidError === "" ? null : androidError;
  }

  try {
    await invoke("open_file_external", { path });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : `Could not open ${path}`;
  }
}

/**
 * Opens an external http(s) link in the system browser.
 *
 * The `opener` plugin rejects a URL that no capability scopes, and that
 * rejection is a promise, not a thrown error: without the `.catch` here the
 * failure is an unhandled rejection and the click does nothing visible. The
 * desktop capability grants `opener:allow-default-urls`, which is what lets an
 * ordinary https link through at all.
 */
export function openExternalUrl(url: string): void {
  void openUrl(url).catch((error) => {
    console.error("Failed to open link:", url, error);
    void message(`Could not open the link:\n${url}`);
  });
}
