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
