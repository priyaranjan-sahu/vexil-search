import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface LicenseStatus {
  pro: boolean;
  plan: string;
  features: string[];
  userId: string | null;
  issuedAt: number | null;
  expiresAt: number | null;
  reason: string;
}

/**
 * Activation server. There is deliberately no production default: a shipped
 * build that falls back to localhost silently talks to the user's own machine,
 * so activation would fail confusingly instead of pointing at the real service.
 * Dev/test builds get localhost so `npm run dev` works with no extra setup.
 */
export function resolveLicenseServer(
  configured: string | undefined,
  isDev: boolean,
): string {
  return configured?.trim() || (isDev ? "http://localhost:8787" : "");
}

const LICENSE_SERVER = resolveLicenseServer(
  import.meta.env.VITE_LICENSE_SERVER as string | undefined,
  Boolean(import.meta.env.DEV),
);

/**
 * Feature names the licensing worker grants. Must stay in sync with the
 * constants in `src-tauri/src/license.rs` — that side is authoritative, and
 * `get_entitlements` resolves the granted set there so the two cannot disagree.
 */
export const FEATURES = {
  background: "background",
  removableDrives: "removable_drives",
  unlimitedPicks: "unlimited_picks",
} as const;

interface LicenseState {
  status: LicenseStatus | null;
  /** Resolved by the Rust side; empty until loaded, which fails closed. */
  entitlements: string[];
  refresh: () => Promise<void>;
  install: (license: string) => Promise<string | null>;
  activateWithEmail: (email: string) => Promise<string | null>;
}

export const useLicenseStore = create<LicenseState>()((set, get) => ({
  status: null,
  entitlements: [],
  refresh: async () => {
    try {
      const status = await invoke<LicenseStatus>("get_license_status");
      const entitlements = await invoke<string[]>("get_entitlements");
      set({ status, entitlements });
    } catch (error) {
      console.error("Failed to fetch license status:", error);
    }
  },
  install: async (license: string) => {
    try {
      const status = await invoke<LicenseStatus>("install_license", {
        license,
      });
      const entitlements = await invoke<string[]>("get_entitlements");
      set({ status, entitlements });
      return null;
    } catch (error) {
      return String(error);
    }
  },
  activateWithEmail: async (email: string) => {
    if (!LICENSE_SERVER) {
      return (
        "This build has no activation server configured. " +
        "Please use an offline activation key instead."
      );
    }
    try {
      const deviceId = await invoke<string>("get_device_id");
      const response = await fetch(`${LICENSE_SERVER}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), deviceId }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        return body?.error ?? `Activation failed (HTTP ${response.status})`;
      }
      const data = (await response.json()) as { license: string };
      return await get().install(data.license);
    } catch (error) {
      return String(error);
    }
  },
}));

/**
 * True when the installed license grants `feature`.
 *
 * This is a UI hint only — the Rust gates in `lib.rs` and `license.rs` are the
 * real enforcement and are keyed on the same feature strings. Never treat a
 * `true` here as authorization for something the backend does not check.
 *
 * Fails closed: an empty entitlement list (not loaded yet, or no license)
 * denies everything.
 */
export const hasFeature = (feature: string): boolean =>
  useLicenseStore.getState().entitlements.includes(feature);
