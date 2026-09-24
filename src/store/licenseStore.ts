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

const LICENSE_SERVER =
  (import.meta.env.VITE_LICENSE_SERVER as string | undefined) ??
  "http://localhost:8787";

interface LicenseState {
  status: LicenseStatus | null;
  refresh: () => Promise<void>;
  install: (license: string) => Promise<string | null>;
  activateWithEmail: (email: string) => Promise<string | null>;
}

export const useLicenseStore = create<LicenseState>()((set, get) => ({
  status: null,
  refresh: async () => {
    try {
      const status = await invoke<LicenseStatus>("get_license_status");
      set({ status });
    } catch (error) {
      console.error("Failed to fetch license status:", error);
    }
  },
  install: async (license: string) => {
    try {
      const status = await invoke<LicenseStatus>("install_license", {
        license,
      });
      set({ status });
      return null;
    } catch (error) {
      return String(error);
    }
  },
  activateWithEmail: async (email: string) => {
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

export const hasProLicense = (): boolean =>
  useLicenseStore.getState().status?.pro ?? false;
