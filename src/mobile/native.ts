/**
 * Bridge to the Android `MainActivity` JavaScript interface injected as
 * `window.VexilAndroid` (see src-tauri/gen/android/.../MainActivity.kt).
 * All members are optional so the code also runs on iOS/desktop where the
 * native folder picker and all-files access flow do not exist.
 */

export interface VexilAndroidBridge {
  hasAllFilesAccess(): boolean;
  openAllFilesAccess(): void;
  pickFolder(): void;
  /**
   * Opens a file in the app that handles its type. Returns "" on success or a
   * human-readable error.
   */
  openFile?(path: string): string;
}

declare global {
  interface Window {
    VexilAndroid?: VexilAndroidBridge;
  }
}

export const androidBridge = (): VexilAndroidBridge | undefined =>
  typeof window !== "undefined" ? window.VexilAndroid : undefined;

export const hasAllFilesAccess = (): boolean =>
  androidBridge()?.hasAllFilesAccess() ?? true;

export const openAllFilesAccess = (): void => {
  androidBridge()?.openAllFilesAccess();
};

export const pickFolder = (): void => {
  androidBridge()?.pickFolder();
};

/**
 * Hands a file to the platform's default handler via the Android bridge.
 *
 * Returns undefined when the bridge is unavailable (iOS, desktop) so callers
 * can fall back, "" when the file opened, and an error message otherwise.
 */
export const openFileWithAndroid = (path: string): string | undefined => {
  const bridge = androidBridge();
  // Must be invoked on the bridge object itself. Android's injected Java
  // object throws "Java bridge method can't be invoked on a non-injected
  // object" when the method is detached from it, so `bridge.openFile(path)`
  // and not `const { openFile } = bridge; openFile(path)`.
  if (typeof bridge?.openFile !== "function") return undefined;
  try {
    return bridge.openFile(path);
  } catch (e) {
    return e instanceof Error ? e.message : `Could not open ${path}`;
  }
};

/** Subscribes to a native CustomEvent; returns an unsubscribe function. */
export function onNativeEvent<T>(
  event: string,
  handler: (detail: T) => void,
): () => void {
  const listener = (e: Event) => {
    handler((e as CustomEvent<T>).detail);
  };
  window.addEventListener(event, listener);
  return () => window.removeEventListener(event, listener);
}
