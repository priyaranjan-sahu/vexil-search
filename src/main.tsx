import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/inter";
import App from "./App";
import MobileApp from "./mobile/MobileApp";
import "./index.css";
import "./mobile/mobile.css";
import { getPlatform } from "./lib/platform";

/**
 * Applies the persisted theme before React mounts.
 *
 * The theme lives in the zustand store and is applied by `useThemeSync` in an
 * effect, which runs after the first paint — a light-theme user sees a dark
 * flash on every launch. Reading the persisted value here and setting the
 * class synchronously closes that gap. `useThemeSync` re-applies it after mount
 * and keeps it in sync when the user changes the setting.
 */
function applyPersistedTheme() {
  try {
    const raw = localStorage.getItem("vexil-storage");
    if (!raw) return;
    const theme = JSON.parse(raw)?.state?.theme;
    if (theme !== "light" && theme !== "dark") return;
    document.documentElement.classList.add(theme);
  } catch {
    // Corrupt or absent storage: fall back to the stylesheet default.
  }
}

applyPersistedTheme();

async function bootstrap() {
  const platform = await getPlatform();
  const rootElement = document.getElementById("root") as HTMLElement;
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      {platform === "desktop" ? <App /> : <MobileApp />}
    </React.StrictMode>,
  );
}

void bootstrap();
