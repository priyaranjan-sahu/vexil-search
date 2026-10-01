import { invoke } from "@tauri-apps/api/core";
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
