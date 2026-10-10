import { useEffect } from "react";
import { useSearchStore } from "../store/searchStore";

/**
 * Applies the persisted theme to <html> on every shell (desktop + mobile).
 * "system" leaves the class list empty so the prefers-color-scheme media
 * query in index.css decides. MobileApp previously never synced the store
 * to the DOM, so the theme picker in Settings had no effect on Android/iOS.
 */
export function useThemeSync(): void {
  const theme = useSearchStore((s) => s.theme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    if (theme !== "system") {
      root.classList.add(theme);
    }
  }, [theme]);
}
