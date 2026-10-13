export interface MobileRoot {
  path: string;
  name: string;
  /** Android: the Storage Access Framework tree URI a picked folder was chosen from. */
  uri?: string;
}

export interface FolderPickedDetail {
  path: string;
  name: string;
  /** Android: the SAF tree URI to persist and index through. */
  uri?: string;
}

export interface FolderPickErrorDetail {
  error: string;
}

export interface AllFilesAccessDetail {
  granted: boolean;
}

export interface MobileFilesImportedDetail {
  imported: number;
}

/** Events dispatched by the Android bridge (MainActivity.kt). */
export const ANDROID_EVENTS = {
  folderPicked: "vexil:folder-picked",
  folderPickError: "vexil:folder-pick-error",
  allFilesAccess: "vexil:all-files-access",
} as const;

/** Events emitted by the Rust backend. */
export const TAURI_EVENTS = {
  indexProgress: "indexing-progress",
  indexDone: "indexing-done",
  mobileFilesImported: "mobile-files-imported",
} as const;
