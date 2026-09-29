import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/inter";
import "@wdio/tauri-plugin";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
