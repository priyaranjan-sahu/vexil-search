import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Determine the correct path to the Tauri binary based on the OS
const getTauriPath = () => {
  const binaryName = process.platform === "win32" ? "vexil.exe" : "vexil";
  // Use debug build for E2E since CI builds in debug mode
  return path.join(__dirname, "src-tauri", "target", "debug", binaryName);
};

export const config = {
  // Test Files
  specs: ["./test/e2e/**/*.ts"],
  exclude: [],

  // Capabilities
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {},
    },
  ],

  services: [
    [
      "tauri",
      {
        appBinaryPath: getTauriPath(),
      },
    ],
  ],

  // Test Configurations
  logLevel: "info",
  bail: 0,
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 60000,
  },
};
