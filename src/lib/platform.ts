import { invoke } from "@tauri-apps/api/core";

export type Platform = "desktop" | "android" | "ios";

let cached: Platform | null = null;

/**
 * Returns the current platform as reported by the Rust `get_platform`
 * command. Falls back to "desktop" when running outside a Tauri context
 * (e.g. plain vite preview or unit tests).
 */
export async function getPlatform(): Promise<Platform> {
  if (cached) return cached;
  try {
    const value = await invoke<string>("get_platform");
    cached = value === "android" || value === "ios" ? value : "desktop";
  } catch {
    cached = "desktop";
  }
  return cached;
}

export const isMobilePlatform = (platform: Platform): boolean =>
  platform === "android" || platform === "ios";

/** Test-only: clears the cached platform so a fresh value is resolved. */
export function resetPlatformCache(): void {
  cached = null;
}
