import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./App.css";

import { DirectoryTree } from "./components/DirectoryTree";
import { ResultsTable } from "./components/ResultsTable";
import { useSearchStore, SearchResult, Theme } from "./store/searchStore";
import { useLicenseStore } from "./store/licenseStore";

function App() {
  const {
    query: searchQuery,
    setQuery: setSearchQuery,
    results,
    browseSections,
    runSearch,
    runBrowse,
    openResult,
    indexingProgress,
    setIndexingProgress,
    dbTotalCount,
    setDbTotalCount,
    activeCategory,
    setActiveCategory,
    activeSizeFilter,
    setActiveSizeFilter,
    activeDateFilter,
    setActiveDateFilter,
    activeMenu,
    setActiveMenu,
    selectedResult,
    setSelectedResult,
    radarFiles,
    setRadarFiles,
    radarToast,
    setRadarToast,
    myPicks,
    addMyPick,
    removeMyPick,
    recentItems,
    theme,
    setTheme,
    shortcut,
    setShortcut,
    runInBackground,
    setRunInBackground,
    showSettings,
    setShowSettings,
    showAbout,
    setShowAbout,
    handleCopyPath,
    handleDelete,
  } = useSearchStore();

  const pro = useLicenseStore((state) => state.status?.pro ?? false);
  const licenseStatus = useLicenseStore((state) => state.status);
  const refreshLicense = useLicenseStore((state) => state.refresh);
  const licenseInstall = useLicenseStore((state) => state.install);

  const [licInput, setLicInput] = useState("");
  const [licError, setLicError] = useState<string | null>(null);
  const [licMessage, setLicMessage] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailMessage, setEmailMessage] = useState<string | null>(null);

  const activateLicense = async (event: React.FormEvent) => {
    event.preventDefault();
    setLicError(null);
    setLicMessage(null);
    const trimmed = licInput.trim();
    if (!trimmed) {
      setLicError("Paste your license key first.");
      return;
    }
    const error = await licenseInstall(trimmed);
    if (error) {
      setLicError(error);
    } else {
      setLicMessage("License activated.");
      setLicInput("");
    }
  };

  const activateByEmail = async (event: React.FormEvent) => {
    event.preventDefault();
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

  // Silently renew a recurring license before it lapses (lazy online check-in).
  // Offline or a lapsed subscription leaves the current token until expiry.
  useEffect(() => {
    const status = useLicenseStore.getState().status;
    if (!status?.pro || !status.expiresAt || !status.userId) return;
    const nowSecs = Math.floor(Date.now() / 1000);
    if (status.expiresAt - nowSecs < 30 * 86_400) {
      void useLicenseStore.getState().activateWithEmail(status.userId);
    }
  }, [pro, licenseStatus]);

  useEffect(() => {
    refreshLicense();
  }, [refreshLicense]);

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    result: SearchResult;
  } | null>(null);

  // Close context menu on click anywhere
  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener("click", closeMenu);
    return () => window.removeEventListener("click", closeMenu);
  }, []);

  // Settings & Theme
  const [tempShortcut, setTempShortcut] = useState("");
  // Track shortcut registration to avoid double-registration in StrictMode
  const shortcutRegisteredRef = useRef(false);
  const currentShortcutRef = useRef(shortcut);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const radarToastTimerRef = useRef<number>(0);

  useEffect(() => {
    // Theme Engine
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    if (theme !== "system") {
      root.classList.add(theme);
    }
  }, [theme]);

  // Sync background running state to backend on mount
  useEffect(() => {
    invoke("set_run_in_background", { enable: runInBackground }).catch(
      console.error,
    );
  }, [runInBackground]);

  // Index on mount only; read the latest dirs from the store so checkbox
  // changes in Settings update the next scan without re-running this effect.
  const triggerIndexing = useCallback(async () => {
    try {
      setIndexingProgress(0);
      const { customDirs, excludedDirs } = useSearchStore.getState();
      await invoke("start_indexing", { customDirs, excludedDirs });
    } catch (error) {
      alert(error);
      setIndexingProgress(null);
    }
  }, [setIndexingProgress]);

  useEffect(() => {
    // Database Indexing Progress Listeners
    const unlistenProgress = listen<number>("indexing-progress", (event) => {
      setIndexingProgress(event.payload);
    });

    const unlistenDone = listen<number>("indexing-done", () => {
      setIndexingProgress(null);
      invoke<number>("get_index_stats")
        .then(setDbTotalCount)
        .catch(console.error);
      // A fresh scan means fresh browse sections when no query is active.
      if (!useSearchStore.getState().query.trim()) {
        void runBrowse();
      }
    });

    invoke<number>("get_index_stats")
      .then(setDbTotalCount)
      .catch(console.error);

    const unlistenRadar = listen<string[]>("live-radar-batch", (event) => {
      setRadarFiles(event.payload);
      setRadarToast(`Updated ${event.payload.length} files`);
      window.clearTimeout(radarToastTimerRef.current);
      radarToastTimerRef.current = window.setTimeout(
        () => setRadarToast(null),
        4000,
      );
    });

    triggerIndexing();

    return () => {
      unlistenProgress.then((f) => f());
      unlistenDone.then((f) => f());
      unlistenRadar.then((f) => f());
    };
  }, [
    triggerIndexing,
    setIndexingProgress,
    setDbTotalCount,
    setRadarFiles,
    setRadarToast,
    runBrowse,
  ]);

  // 3. Register Global Shortcut
  useEffect(() => {
    let mounted = true;

    const setupShortcut = async () => {
      // Force unregister any existing shortcut first (handles stale registrations)
      try {
        await unregister(shortcut);
      } catch {
        // Ignore
      }

      // Only unregister/register if shortcut actually changed
      if (currentShortcutRef.current !== shortcut) {
        try {
          await unregister(currentShortcutRef.current);
        } catch {
          // Ignore unregister errors if not registered
        }
        currentShortcutRef.current = shortcut;
        shortcutRegisteredRef.current = false;
      } else if (shortcutRegisteredRef.current) {
        // Shortcut hasn't changed and already registered (StrictMode double-mount)
        return;
      }

      try {
        await register(shortcut, async (event) => {
          if (!mounted) return;
          if (event.state === "Pressed") {
            try {
              const appWindow = getCurrentWindow();
              const isVisible = await appWindow.isVisible();
              const isMinimized = await appWindow.isMinimized();
              if (isVisible && !isMinimized) {
                await appWindow.minimize();
              } else {
                if (isMinimized) await appWindow.unminimize();
                await appWindow.show();
                await appWindow.setFocus();
                document
                  .querySelector<HTMLInputElement>(".search-input")
                  ?.focus();
              }
            } catch (error) {
              console.error("Failed to toggle window via hotkey:", error);
            }
          }
        });
        shortcutRegisteredRef.current = true;
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        if (!errorMessage.includes("already registered")) {
          console.error("Failed to register shortcut:", error);
        }
      }
    };

    setupShortcut();

    return () => {
      mounted = false;
      // Only unregister when shortcut changes or app truly unmounts
      // Don't unregister on StrictMode double-mount cleanup
    };
  }, [shortcut]);

  // Live search, debounced while typing (debounce lives in the store action)
  useEffect(() => {
    runSearch(searchQuery);
  }, [searchQuery, activeCategory, runSearch]);

  // Escape clears the query / closes settings/about
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showSettings) {
          setShowSettings(false);
        } else if (showAbout) {
          setShowAbout(false);
        } else {
          setSearchQuery("");
        }
      } else if (e.ctrlKey && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        setSearchQuery("");
        document.querySelector<HTMLInputElement>(".search-input")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSettings, showAbout, setShowSettings, setShowAbout, setSearchQuery]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    runSearch(searchQuery, true);
  };

  const saveShortcut = (e: React.FormEvent) => {
    e.preventDefault();
    if (tempShortcut.trim()) {
      setShortcut(tempShortcut.trim());
      setTempShortcut("");
    }
  };

  const getFilteredResults = useCallback(() => {
    return results.filter((r) => {
      // Size filter
      if (activeSizeFilter !== "Any Size") {
        const sizeInMB = r.size / (1024 * 1024);
        switch (activeSizeFilter) {
          case "Small (< 1MB)":
            if (sizeInMB >= 1) return false;
            break;
          case "Medium (1-100MB)":
            if (sizeInMB < 1 || sizeInMB > 100) return false;
            break;
          case "Large (> 100MB)":
            if (sizeInMB <= 100) return false;
            break;
        }
      }

      // Date filter
      if (activeDateFilter !== "Any Time") {
        const modifiedDate = new Date(r.modified * 1000);
        const now = new Date();
        switch (activeDateFilter) {
          case "Today": {
            const todayStart = new Date(
              now.getFullYear(),
              now.getMonth(),
              now.getDate(),
            );
            if (modifiedDate < todayStart) return false;
            break;
          }
          case "This Week": {
            const weekStart = new Date(now);
            weekStart.setDate(now.getDate() - now.getDay());
            weekStart.setHours(0, 0, 0, 0);
            if (modifiedDate < weekStart) return false;
            break;
          }
          case "This Month": {
            const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
            if (modifiedDate < monthStart) return false;
            break;
          }
        }
      }

      return true;
    });
  }, [results, activeSizeFilter, activeDateFilter]);
  const filteredResults = useMemo(
    () => getFilteredResults(),
    [getFilteredResults],
  );

  const browsing = searchQuery.trim() === "";
  const browseFileCount = useMemo(
    () =>
      browseSections.reduce(
        (total, section) => total + section.files.length,
        0,
      ),
    [browseSections],
  );

  return (
    <div className="container">
      {/* 1. Menu Bar */}
      <div className="menu-bar">
        <div
          className="menu-item-container"
          onMouseLeave={() => setActiveMenu(null)}
        >
          <div
            className="menu-item"
            onMouseEnter={() => setActiveMenu("File")}
            onClick={() => setActiveMenu("File")}
          >
            File
          </div>
          {activeMenu === "File" && (
            <div className="menu-dropdown">
              <div
                className="menu-dropdown-item"
                onClick={() => {
                  setSearchQuery("");
                  setActiveMenu(null);
                  document
                    .querySelector<HTMLInputElement>(".search-input")
                    ?.focus();
                }}
              >
                New Search <span style={{ opacity: 0.5 }}>Ctrl+N</span>
              </div>
              <div className="menu-dropdown-divider"></div>
              <div
                className="menu-dropdown-item"
                onClick={() => invoke("exit_app").catch(console.error)}
              >
                Exit
              </div>
            </div>
          )}
        </div>
        <div
          className="menu-item-container"
          onMouseLeave={() => setActiveMenu(null)}
        >
          <div
            className="menu-item"
            onMouseEnter={() => setActiveMenu("Edit")}
            onClick={() => setActiveMenu("Edit")}
          >
            Edit
          </div>
          {activeMenu === "Edit" && (
            <div className="menu-dropdown">
              <div
                className="menu-dropdown-item"
                onClick={() => {
                  handleCopyPath();
                  setActiveMenu(null);
                }}
              >
                Copy <span style={{ opacity: 0.5 }}>Ctrl+C</span>
              </div>
              <div
                className="menu-dropdown-item"
                onClick={async () => {
                  try {
                    setSearchQuery(await navigator.clipboard.readText());
                  } catch {
                    /* clipboard unavailable */
                  }
                  setActiveMenu(null);
                }}
              >
                Paste <span style={{ opacity: 0.5 }}>Ctrl+V</span>
              </div>
              <div className="menu-dropdown-divider"></div>
              <div
                className="menu-dropdown-item"
                onClick={() => {
                  document
                    .querySelector<HTMLInputElement>(".search-input")
                    ?.select();
                  setActiveMenu(null);
                }}
              >
                Select All <span style={{ opacity: 0.5 }}>Ctrl+A</span>
              </div>
            </div>
          )}
        </div>
        <div
          className="menu-item-container"
          onMouseLeave={() => setActiveMenu(null)}
        >
          <div
            className="menu-item"
            onMouseEnter={() => setActiveMenu("View")}
            onClick={() => setActiveMenu("View")}
          >
            View
          </div>
          {activeMenu === "View" && (
            <div className="menu-dropdown">
              <div
                className="menu-dropdown-item"
                onClick={() => setShowSettings(true)}
              >
                Theme Settings
              </div>
            </div>
          )}
        </div>
        <div
          className="menu-item-container"
          onMouseLeave={() => setActiveMenu(null)}
        >
          <div
            className="menu-item"
            onMouseEnter={() => setActiveMenu("Tools")}
            onClick={() => setActiveMenu("Tools")}
          >
            Tools
          </div>
          {activeMenu === "Tools" && (
            <div className="menu-dropdown">
              <div
                className="menu-dropdown-item"
                onClick={() => setShowSettings(true)}
              >
                Preferences...
              </div>
            </div>
          )}
        </div>
        <div
          className="menu-item-container"
          onMouseLeave={() => setActiveMenu(null)}
        >
          <div
            className="menu-item"
            onMouseEnter={() => setActiveMenu("Help")}
            onClick={() => setActiveMenu("Help")}
          >
            Help
          </div>
          {activeMenu === "Help" && (
            <div className="menu-dropdown">
              <div
                className="menu-dropdown-item"
                onClick={() => {
                  setShowAbout(true);
                  setActiveMenu(null);
                }}
              >
                About Vexil
              </div>
              <div className="menu-dropdown-divider"></div>
              <div
                className="menu-dropdown-item"
                onClick={() => {
                  openUrl(
                    "https://github.com/priyaranjan-sahu/vexil-search/issues/new",
                  );
                  setActiveMenu(null);
                }}
              >
                Send Feedback / Report Bug
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 2. Toolbar */}
      <div className="toolbar">
        <form className="search-wrapper" onSubmit={handleSearch}>
          <svg
            className="search-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            className="search-input"
            placeholder="Search documents, apps, files..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </form>

        <div className="toolbar-actions">
          <div className="toolbar-filters">
            <button
              className={`filter-btn ${activeCategory === "All" ? "active" : ""}`}
              onClick={() => setActiveCategory("All")}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
              </svg>
              Show All
            </button>
            <button
              className={`filter-btn ${activeCategory === "Music" ? "active" : ""}`}
              onClick={() => setActiveCategory("Music")}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M9 18V5l12-2v13"></path>
                <circle cx="6" cy="18" r="3"></circle>
                <circle cx="18" cy="16" r="3"></circle>
              </svg>
              Music
            </button>
            <button
              className={`filter-btn ${activeCategory === "Videos" ? "active" : ""}`}
              onClick={() => setActiveCategory("Videos")}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect
                  x="2"
                  y="2"
                  width="20"
                  height="20"
                  rx="2.18"
                  ry="2.18"
                ></rect>
                <line x1="7" y1="2" x2="7" y2="22"></line>
                <line x1="17" y1="2" x2="17" y2="22"></line>
                <line x1="2" y1="12" x2="22" y2="12"></line>
                <line x1="2" y1="7" x2="7" y2="7"></line>
                <line x1="2" y1="17" x2="7" y2="17"></line>
                <line x1="17" y1="17" x2="22" y2="17"></line>
                <line x1="17" y1="7" x2="22" y2="7"></line>
              </svg>
              Videos
            </button>
            <button
              className={`filter-btn ${activeCategory === "Programs" ? "active" : ""}`}
              onClick={() => setActiveCategory("Programs")}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                <line x1="8" y1="21" x2="16" y2="21"></line>
                <line x1="12" y1="17" x2="12" y2="21"></line>
              </svg>
              Programs
            </button>
            <button
              className={`filter-btn ${activeCategory === "Images" ? "active" : ""}`}
              onClick={() => setActiveCategory("Images")}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                <polyline points="21 15 16 10 5 21"></polyline>
              </svg>
              Images
            </button>
            <button
              className={`filter-btn ${activeCategory === "Documents" ? "active" : ""}`}
              onClick={() => setActiveCategory("Documents")}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
                <line x1="16" y1="13" x2="8" y2="13"></line>
                <line x1="16" y1="17" x2="8" y2="17"></line>
                <polyline points="10 9 9 9 8 9"></polyline>
              </svg>
              Docs
            </button>
            <button
              className={`filter-btn ${activeCategory === "Archives" ? "active" : ""}`}
              onClick={() => setActiveCategory("Archives")}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="16" y1="2" x2="16" y2="4"></line>
                <line x1="8" y1="2" x2="8" y2="4"></line>
                <circle cx="12" cy="11" r="1"></circle>
                <path d="M12 12v6"></path>
              </svg>
              Archives
            </button>
            <button
              className={`filter-btn ${activeCategory === "Code" ? "active" : ""}`}
              onClick={() => setActiveCategory("Code")}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polyline points="16 18 22 12 16 6"></polyline>
                <polyline points="8 6 2 12 8 18"></polyline>
              </svg>
              Code
            </button>
            <button
              className={`filter-btn ${activeCategory === "Folder" ? "active" : ""}`}
              onClick={() => setActiveCategory("Folder")}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
              </svg>
              Folders
            </button>
            <div className="filter-divider"></div>
            <select
              className="advanced-filter-select"
              value={activeSizeFilter}
              onChange={(e) => setActiveSizeFilter(e.target.value)}
            >
              <option value="Any Size">Any Size</option>
              <option value="Small (< 1MB)">Small (&lt; 1MB)</option>
              <option value="Medium (1-100MB)">Medium (1-100MB)</option>
              <option value="Large (> 100MB)">Large (&gt; 100MB)</option>
            </select>
            <select
              className="advanced-filter-select"
              value={activeDateFilter}
              onChange={(e) => setActiveDateFilter(e.target.value)}
            >
              <option value="Any Time">Any Time</option>
              <option value="Today">Today</option>
              <option value="This Week">This Week</option>
              <option value="This Month">This Month</option>
            </select>
          </div>

          <div className="toolbar-divider" style={{ marginLeft: "auto" }}></div>

          <div className="toolbar-group">
            <button
              className="tool-btn"
              disabled={!selectedResult}
              onClick={() => selectedResult && openResult(selectedResult)}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15 3 21 3 21 9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
              Open
            </button>
            <button
              className="tool-btn"
              disabled={!selectedResult}
              onClick={handleCopyPath}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              Copy Path
            </button>
            <button
              className="tool-btn"
              disabled={!selectedResult}
              onClick={handleDelete}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
              Delete
            </button>
          </div>
        </div>
      </div>

      {/* Info Bar */}
      <div className="info-bar">
        {browsing ? (
          <>
            {browseFileCount > 0
              ? `${browseFileCount} file${browseFileCount === 1 ? "" : "s"} shown`
              : "Browse by category"}{" "}
            ·{" "}
            {activeCategory === "All"
              ? "All categories"
              : `Showing ${activeCategory}`}
          </>
        ) : (
          <>
            {filteredResults.length} items found
            {activeCategory !== "All" && <> · Showing {activeCategory}</>}
          </>
        )}
        <span style={{ marginLeft: "16px", color: "var(--text-secondary)" }}>
          · Database: {dbTotalCount.toLocaleString()} files
        </span>
        {indexingProgress !== null && (
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              marginLeft: "16px",
              color: "var(--brand-primary)",
            }}
          >
            <div
              className="spinner"
              style={{
                width: "12px",
                height: "12px",
                borderTopColor: "var(--brand-primary)",
              }}
            ></div>
            Scanning: {indexingProgress.toLocaleString()}
          </span>
        )}
      </div>

      {/* 3. Main Content Grid */}
      <div className="main-content">
        {/* Results Panel (Left Side Now) */}
        <ResultsTable
          filteredResults={filteredResults}
          browseSections={browseSections}
          isBrowsing={browsing}
          selectedResult={selectedResult}
          setSelectedResult={setSelectedResult}
          setContextMenu={setContextMenu}
        />

        {/* Right Sidebar */}
        <aside className="right-sidebar">
          <div className="sidebar-box">
            <div className="sidebar-box-header">Live Radar</div>
            <div className="sidebar-box-content">
              {radarFiles.length > 0 ? (
                <div
                  className="sidebar-item"
                  onClick={() => openResult(radarFiles[radarFiles.length - 1])}
                  title={radarFiles[radarFiles.length - 1]}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                    <line x1="12" y1="18" x2="12" y2="12"></line>
                    <line x1="9" y1="15" x2="15" y2="15"></line>
                  </svg>
                  {radarFiles[radarFiles.length - 1].split(/[\\/]/).pop() ||
                    radarFiles[radarFiles.length - 1]}
                </div>
              ) : (
                <div
                  className="sidebar-item"
                  style={{ color: "var(--text-muted)" }}
                >
                  Monitoring Downloads...
                </div>
              )}
            </div>
          </div>

          <div
            className="sidebar-box"
            style={{ flex: 1, borderBottom: "none" }}
          >
            <div className="sidebar-box-header">My Picks</div>
            <div className="sidebar-box-content">
              {myPicks.length > 0 ? (
                myPicks.map((pick) => (
                  <div
                    className="sidebar-item"
                    key={pick.id}
                    onClick={() => openResult(pick)}
                    title={pick.path}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                    </svg>
                    {pick.title}
                  </div>
                ))
              ) : (
                <div
                  className="sidebar-item"
                  style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}
                >
                  Right-click a file to pin it here
                </div>
              )}
            </div>

            <div className="sidebar-box-header" style={{ marginTop: "16px" }}>
              Recent
            </div>
            <div className="sidebar-box-content">
              {recentItems.length > 0 ? (
                recentItems.map((recent, i) => (
                  <div
                    className="sidebar-item"
                    key={`recent-${i}`}
                    onClick={() => openResult(recent)}
                    title={recent.path}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <circle cx="12" cy="12" r="10"></circle>
                      <polyline points="12 6 12 12 16 14"></polyline>
                    </svg>
                    {recent.title}
                  </div>
                ))
              ) : (
                <div
                  className="sidebar-item"
                  style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}
                >
                  Recent files will appear here...
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>

      {/* Settings Modal Overlay */}
      {showSettings && (
        <div
          className="settings-overlay"
          onClick={() => setShowSettings(false)}
        >
          <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
            <h2 className="settings-header">Preferences</h2>

            <div className="settings-row" style={{ display: "block" }}>
              <label style={{ display: "block", marginBottom: "8px" }}>
                Pro License
                {pro && licenseStatus && (
                  <span
                    style={{
                      fontSize: "0.65rem",
                      background: "var(--brand-primary)",
                      color: "white",
                      padding: "2px 5px",
                      borderRadius: "4px",
                      marginLeft: "8px",
                    }}
                  >
                    ACTIVE · {licenseStatus.plan.toUpperCase()}
                  </span>
                )}
              </label>
              {pro && licenseStatus ? (
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  {licenseStatus.userId && (
                    <div>Licensed to: {licenseStatus.userId}</div>
                  )}
                  <div>
                    Features: {licenseStatus.features.join(", ") || "—"}
                  </div>
                  {licenseStatus.expiresAt && (
                    <div>
                      Expires:{" "}
                      {new Date(
                        licenseStatus.expiresAt * 1000,
                      ).toLocaleDateString()}
                    </div>
                  )}
                  <div style={{ marginTop: "4px" }}>This device: ✓</div>
                </div>
              ) : (
                <>
                  <form onSubmit={activateByEmail} className="shortcut-form">
                    <input
                      type="email"
                      value={emailInput}
                      onChange={(e) => setEmailInput(e.target.value)}
                      placeholder="Email used at checkout"
                      style={{ width: "100%" }}
                    />
                    <button type="submit">Activate</button>
                    {emailError && (
                      <div
                        style={{
                          color: "#d9534f",
                          fontSize: "0.75rem",
                          marginTop: "6px",
                        }}
                      >
                        {emailError}
                      </div>
                    )}
                    {emailMessage && (
                      <div
                        style={{
                          color: "var(--brand-primary)",
                          fontSize: "0.75rem",
                          marginTop: "6px",
                        }}
                      >
                        {emailMessage}
                      </div>
                    )}
                  </form>
                  <form
                    onSubmit={activateLicense}
                    className="shortcut-form"
                    style={{ marginTop: "8px" }}
                  >
                    <input
                      type="text"
                      value={licInput}
                      onChange={(e) => setLicInput(e.target.value)}
                      placeholder="Or paste a license key"
                      style={{ width: "100%" }}
                    />
                    <button type="submit">Activate</button>
                    {licError && (
                      <div
                        style={{
                          color: "#d9534f",
                          fontSize: "0.75rem",
                          marginTop: "6px",
                        }}
                      >
                        {licError}
                      </div>
                    )}
                    {licMessage && (
                      <div
                        style={{
                          color: "var(--brand-primary)",
                          fontSize: "0.75rem",
                          marginTop: "6px",
                        }}
                      >
                        {licMessage}
                      </div>
                    )}
                  </form>
                  {licenseStatus?.reason &&
                    licenseStatus.reason !== "No license installed" && (
                      <div
                        style={{
                          color: "var(--text-muted)",
                          fontSize: "0.75rem",
                          marginTop: "6px",
                        }}
                      >
                        {licenseStatus.reason}
                      </div>
                    )}
                </>
              )}
            </div>

            <div className="settings-row">
              <label>
                Run in Background
                {!pro && (
                  <span
                    style={{
                      fontSize: "0.65rem",
                      background: "var(--brand-primary)",
                      color: "white",
                      padding: "2px 5px",
                      borderRadius: "4px",
                      marginLeft: "8px",
                    }}
                  >
                    👑 PRO
                  </span>
                )}
              </label>
              <div
                className="settings-controls"
                style={{ display: "flex", alignItems: "center" }}
              >
                <input
                  type="checkbox"
                  checked={runInBackground}
                  onChange={(e) => setRunInBackground(e.target.checked)}
                  id="bgToggle"
                  style={{ marginRight: "10px", width: "16px", height: "16px" }}
                />
                <label
                  htmlFor="bgToggle"
                  style={{
                    fontSize: "0.85rem",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    margin: 0,
                  }}
                >
                  Minimize to system tray on close
                </label>
              </div>
            </div>

            <div className="settings-row">
              <label>Appearance Theme</label>
              <select
                className="theme-select"
                value={theme}
                onChange={(e) => setTheme(e.target.value as Theme)}
              >
                <option value="system">System (Auto)</option>
                <option value="dark">Dark Mode</option>
                <option value="light">Light Mode</option>
              </select>
            </div>

            <div className="settings-row">
              <label>Global Hotkey</label>
              <form onSubmit={saveShortcut} className="shortcut-form">
                <input
                  type="text"
                  value={tempShortcut || shortcut}
                  onChange={(e) => setTempShortcut(e.target.value)}
                  placeholder="e.g. CommandOrControl+Shift+Space"
                />
                <button type="submit">Set</button>
              </form>
            </div>

            <div className="settings-row" style={{ display: "block" }}>
              <label style={{ display: "block", marginBottom: "8px" }}>
                Custom Scan Paths
              </label>
              <DirectoryTree />
            </div>

            <div
              className="settings-row"
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                borderBottom: "none",
                paddingBottom: 0,
              }}
            >
              <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    openUrl(
                      "https://github.com/priyaranjan-sahu/vexil-search/blob/master/PRIVACY_POLICY.md",
                    );
                  }}
                  style={{
                    color: "var(--brand-primary)",
                    textDecoration: "none",
                    marginRight: "12px",
                  }}
                >
                  Privacy Policy
                </a>
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    openUrl(
                      "https://github.com/priyaranjan-sahu/vexil-search/blob/master/TERMS_AND_CONDITIONS.md",
                    );
                  }}
                  style={{
                    color: "var(--brand-primary)",
                    textDecoration: "none",
                  }}
                >
                  Terms of Service
                </a>
              </span>
            </div>

            <button
              className="close-settings-btn"
              style={{
                background: "var(--brand-primary)",
                color: "white",
                fontWeight: "bold",
              }}
              onClick={() => setShowSettings(false)}
            >
              Save Settings
            </button>
          </div>
        </div>
      )}

      {/* About Modal */}
      {showAbout && (
        <div className="settings-overlay" onClick={() => setShowAbout(false)}>
          <div
            className="settings-panel"
            onClick={(e) => e.stopPropagation()}
            style={{ width: "360px", textAlign: "center" }}
          >
            <div style={{ marginBottom: "16px" }}>
              <svg
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--brand-primary)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ margin: "0 auto" }}
              >
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
            </div>
            <h2 className="settings-header" style={{ marginBottom: "8px" }}>
              Vexil Search
            </h2>
            <p
              style={{
                color: "var(--text-secondary)",
                fontSize: "0.85rem",
                marginBottom: "24px",
              }}
            >
              Version 0.1.0
              <br />
              <br />A lightning-fast, local-first search engine designed for
              privacy and speed.
            </p>
            <div
              style={{
                padding: "16px",
                background: "var(--result-hover-bg)",
                borderRadius: "8px",
                fontSize: "0.8rem",
                color: "var(--text-secondary)",
                marginBottom: "24px",
                border: "1px solid var(--surface-border)",
              }}
            >
              Built with <strong>Tauri</strong> and <strong>React</strong>.
              <br />
              <br />
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  openUrl(
                    "https://github.com/priyaranjan-sahu/vexil-search/issues/new",
                  );
                }}
                style={{
                  color: "var(--brand-primary)",
                  textDecoration: "none",
                }}
              >
                Send Feedback or Report a Bug
              </a>
            </div>
            <button
              className="shortcut-form button"
              style={{
                width: "100%",
                background: "var(--brand-primary)",
                color: "white",
                padding: "10px",
                borderRadius: "8px",
                border: "none",
                fontWeight: "600",
                cursor: "pointer",
              }}
              onClick={() => setShowAbout(false)}
            >
              OK
            </button>
          </div>
        </div>
      )}

      {/* Custom Context Menu */}
      {contextMenu && (
        <div
          style={{
            position: "fixed",
            top: contextMenu.y,
            left: contextMenu.x,
            backgroundColor: "var(--surface-color)",
            border: "1px solid var(--surface-border)",
            borderRadius: "6px",
            boxShadow: "0 4px 15px rgba(0,0,0,0.2)",
            padding: "4px",
            zIndex: 9999,
            minWidth: "160px",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="menu-dropdown-item"
            onClick={() => {
              const res = contextMenu.result;
              if (myPicks.some((p) => p.id === res.id)) {
                removeMyPick(res.id);
              } else {
                addMyPick(res);
              }
              setContextMenu(null);
            }}
          >
            {myPicks.some((p) => p.id === contextMenu.result.id)
              ? "Unpin from My Picks"
              : "Pin to My Picks"}
          </div>
          <div
            className="menu-dropdown-item"
            onClick={() => {
              if (navigator.clipboard) {
                navigator.clipboard.writeText(contextMenu.result.path);
              }
              setContextMenu(null);
            }}
          >
            Copy Path
          </div>
        </div>
      )}

      {radarToast && (
        <div className="radar-toast">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
            <line x1="12" y1="18" x2="12" y2="12"></line>
            <line x1="9" y1="15" x2="15" y2="15"></line>
          </svg>
          <div className="radar-toast-content">
            <span className="radar-toast-title">Live Radar Found New File</span>
            <span className="radar-toast-filename">
              {radarFiles.length > 0
                ? radarFiles[radarFiles.length - 1].split(/[\\/]/).pop()
                : radarToast}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
