import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/inter";
import App from "./App";
import MobileApp from "./mobile/MobileApp";
import "./index.css";
import "./mobile/mobile.css";
import { getPlatform } from "./lib/platform";

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
