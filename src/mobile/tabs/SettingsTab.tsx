import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useLicenseStore } from "../../store/licenseStore";
import { useSearchStore, Theme } from "../../store/searchStore";
import type { Platform } from "../../lib/platform";
import { TRASH_RETENTION_DAYS } from "../../lib/confirmDelete";
import type { MobileRoot } from "../types";
import { openAllFilesAccess, pickFolder } from "../native";

export const SettingsTab = ({
  platform,
  allFilesAccess,
  roots,
  onRemoveRoot,
  onReindex,
  onToast,
}: {
  platform: Platform;
  allFilesAccess: boolean;
  roots: MobileRoot[];
  onRemoveRoot: (path: string) => void;
  onReindex: () => void;
  onToast: (message: string) => void;
}) => {
  const theme = useSearchStore((s) => s.theme);
  const setTheme = useSearchStore((s) => s.setTheme);
  const setShowTrash = useSearchStore((s) => s.setShowTrash);
  const status = useLicenseStore((s) => s.status);
  const install = useLicenseStore((s) => s.install);
  const pro = status?.pro ?? false;
  const entitlements = useLicenseStore((state) => state.entitlements);

  const [licInput, setLicInput] = useState("");
  const [licError, setLicError] = useState<string | null>(null);
  const [licMessage, setLicMessage] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailMessage, setEmailMessage] = useState<string | null>(null);

  const activateLicense = async (e: React.FormEvent) => {
    e.preventDefault();
    setLicError(null);
    setLicMessage(null);
    const trimmed = licInput.trim();
    if (!trimmed) {
      setLicError("Paste your license key first.");
      return;
    }
    const error = await install(trimmed);
    if (error) {
      setLicError(error);
    } else {
      setLicMessage("License activated.");
      setLicInput("");
    }
  };

  const activateByEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailError(null);
    setEmailMessage(null);
    const email = emailInput.trim();
    if (!email) {
      setEmailError("Enter the email you paid with.");
      return;
    }
    const error = await useLicenseStore.getState().activateWithEmail(email);
    if (error) {
      setEmailError(error);
    } else {
      setEmailMessage("License activated for this device.");
      setEmailInput("");
    }
  };

  const addRoot = () => {
    if (platform === "android") {
      pickFolder();
      onToast("Choose a folder to index");
    } else if (platform === "ios") {
      void invoke("import_mobile_files")
        .then((msg) => onToast(String(msg)))
        .catch((err) => onToast(String(err)));
      onToast("Pick files to import");
    }
  };

  return (
    <section className="mob-tab-content">
      <div className="mob-tab-title">Settings</div>
      <div className="mob-scroll">
        <div className="mob-settings-group">
          <div className="mob-settings-label">Pro License</div>
          {pro && status ? (
            <div className="mob-settings-info">
              <span className="mob-pro-badge">
                ACTIVE · {status.plan.toUpperCase()}
              </span>
              {status.userId && <div>Licensed to: {status.userId}</div>}
              {/* Resolved by the backend, not the raw signed list: a legacy
                  license grants everything but lists nothing. */}
              {entitlements.length > 0 && (
                <div>Features: {entitlements.join(", ")}</div>
              )}
              {status.expiresAt && (
                <div>
                  Expires:{" "}
                  {new Date(status.expiresAt * 1000).toLocaleDateString()}
                </div>
              )}
            </div>
          ) : (
            <form className="mob-settings-form" onSubmit={activateByEmail}>
              <input
                type="email"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                placeholder="Email used at checkout"
              />
              <button type="submit">Activate</button>
              {emailError && <div className="mob-error">{emailError}</div>}
              {emailMessage && (
                <div className="mob-success">{emailMessage}</div>
              )}
            </form>
          )}
          {!pro && (
            <form className="mob-settings-form" onSubmit={activateLicense}>
              <input
                type="text"
                value={licInput}
                onChange={(e) => setLicInput(e.target.value)}
                placeholder="Or paste a license key"
              />
              <button type="submit">Activate</button>
              {licError && <div className="mob-error">{licError}</div>}
              {licMessage && <div className="mob-success">{licMessage}</div>}
            </form>
          )}
        </div>

        <div className="mob-settings-group">
          <div className="mob-settings-label">Appearance</div>
          <select
            className="mob-select"
            value={theme}
            onChange={(e) => setTheme(e.target.value as Theme)}
          >
            <option value="system">System (Auto)</option>
            <option value="dark">Dark Mode</option>
            <option value="light">Light Mode</option>
          </select>
        </div>

        {(platform === "android" || platform === "ios") && (
          <div className="mob-settings-group">
            <div className="mob-settings-label">Scan Folders</div>
            {platform === "android" && (
              <>
                <div className="mob-settings-row">
                  <span>
                    All Files Access:{" "}
                    {allFilesAccess ? (
                      <span className="mob-success">Granted</span>
                    ) : (
                      <span className="mob-error">Not granted</span>
                    )}
                  </span>
                  {!allFilesAccess && (
                    <button
                      type="button"
                      className="mob-btn"
                      onClick={openAllFilesAccess}
                    >
                      Grant Access
                    </button>
                  )}
                </div>
                <button type="button" className="mob-btn" onClick={addRoot}>
                  Add Folder
                </button>
                <p className="mob-hint">
                  Use All Files Access for instant full-device search, or the
                  folder picker to index a specific folder.
                </p>
              </>
            )}
            {platform === "ios" && (
              <>
                <button type="button" className="mob-btn" onClick={addRoot}>
                  Import Files…
                </button>
                <p className="mob-hint">
                  Picked files are copied into the app and stay searchable.
                </p>
              </>
            )}

            <div className="mob-settings-label">Indexed Folders</div>
            {roots.length > 0 ? (
              <ul className="mob-roots">
                {roots.map((root) => (
                  <li key={root.path} className="mob-root">
                    <span className="mob-root-label">{root.name}</span>
                    <span className="mob-root-path">{root.path}</span>
                    <button
                      type="button"
                      className="mob-root-remove"
                      onClick={() => onRemoveRoot(root.path)}
                      aria-label={`Remove ${root.name}`}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mob-hint">No extra folders indexed yet.</p>
            )}
            <button
              type="button"
              className="mob-btn-primary"
              onClick={onReindex}
            >
              Reindex Now
            </button>
          </div>
        )}

        <div className="mob-settings-group">
          <div className="mob-settings-label">Trash</div>
          <button
            type="button"
            className="mob-btn"
            onClick={() => setShowTrash(true)}
          >
            Open Trash
          </button>
          <p className="mob-hint">
            Deleted files stay here for {TRASH_RETENTION_DAYS} days and can be
            put back.
          </p>
        </div>

        <div className="mob-settings-group">
          <div className="mob-settings-label">Vexil Search · v0.1.0</div>
          <div className="mob-settings-links">
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                void openUrl(
                  "https://github.com/priyaranjan-sahu/vexil-search/blob/master/PRIVACY_POLICY.md",
                );
              }}
            >
              Privacy Policy
            </a>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                void openUrl(
                  "https://github.com/priyaranjan-sahu/vexil-search/blob/master/TERMS_AND_CONDITIONS.md",
                );
              }}
            >
              Terms of Service
            </a>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                void openUrl(
                  "https://github.com/priyaranjan-sahu/vexil-search/issues/new",
                );
              }}
            >
              Send Feedback
            </a>
          </div>
        </div>
      </div>
    </section>
  );
};
