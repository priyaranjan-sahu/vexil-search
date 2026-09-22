import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { openPath } from "@tauri-apps/plugin-opener";
import "./App.css";

interface SearchResult {
  id: number;
  title: string;
  snippet: string;
  path: string;
  relevance: number;
}

type Theme = "system" | "light" | "dark";

/** Renders an FTS snippet safely: only <b>...</b> becomes bold, everything
 * else is escaped by React (no dangerouslySetInnerHTML). */
function HighlightedSnippet({ text }: { text: string }) {
  const parts = text.split(/(<b>|<\/b>)/);
  let bold = false;
  const nodes: React.ReactNode[] = [];
  for (const part of parts) {
    if (part === "<b>") {
      bold = true;
    } else if (part === "</b>") {
      bold = false;
    } else if (part) {
      nodes.push(
        bold ? (
          <b key={nodes.length}>{part}</b>
        ) : (
          <span key={nodes.length}>{part}</span>
        ),
      );
    }
  }
  return <>{nodes}</>;
}

function App() {
  const [searchQuery, setSearchQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [indexingProgress, setIndexingProgress] = useState<number | null>(null);

  const [activeCategory, setActiveCategory] = useState<string>("All");
  const [activeMenu, setActiveMenu] = useState<string | null>(null);

  // Ava Find Features (Renamed to avoid copy)
  const [selectedResult, setSelectedResult] = useState<SearchResult | null>(
    null,
  );
  const [radarToast, setRadarToast] = useState<string | null>(null);

  // Settings & Theme
  const [showSettings, setShowSettings] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("vexil-theme") as Theme) || "system",
  );

  // Shortcut state
  const [shortcut, setShortcut] = useState(
    () =>
      localStorage.getItem("vexil-shortcut") || "CommandOrControl+Shift+Space",
  );
  const [tempShortcut, setTempShortcut] = useState("");
  // Track shortcut registration to avoid double-registration in StrictMode
  const shortcutRegisteredRef = useRef(false);
  const currentShortcutRef = useRef(shortcut);

  useEffect(() => {
    // Theme Engine
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    if (theme !== "system") {
      root.classList.add(theme);
    }
    localStorage.setItem("vexil-theme", theme);
  }, [theme]);

  useEffect(() => {
    // Database Indexing Progress Listeners
    const unlistenProgress = listen<number>("indexing-progress", (event) => {
      setIndexingProgress(event.payload);
    });

    const unlistenDone = listen<number>("indexing-done", () => {
      setIndexingProgress(null);
    });

    const unlistenRadar = listen<string>("live-radar-file", (event) => {
      setRadarToast(event.payload);
      setTimeout(() => setRadarToast(null), 4000);
    });

    invoke("start_indexing");

    return () => {
      unlistenProgress.then((f) => f());
      unlistenDone.then((f) => f());
      unlistenRadar.then((f) => f());
    };
  }, []);

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
            const appWindow = getCurrentWindow();
            const isVisible = await appWindow.isVisible();
            const isMinimized = await appWindow.isMinimized();
            if (isVisible && !isMinimized) {
              await appWindow.minimize();
            } else {
              if (isMinimized) await appWindow.unminimize();
              await appWindow.show();
              await appWindow.setFocus();
            }
          }
        });
        shortcutRegisteredRef.current = true;
        localStorage.setItem("vexil-shortcut", shortcut);
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

  const runSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    setIsSearching(true);
    try {
      const res: SearchResult[] = await invoke("search_files", { query });
      setResults(res);
      setSelectedResult(null);
    } catch (error) {
      console.error("Failed to search files:", error);
    } finally {
      setIsSearching(false);
    }
  }, []);

  // Live search, debounced while typing
  useEffect(() => {
    const handle = setTimeout(() => {
      runSearch(searchQuery);
    }, 250);
    return () => clearTimeout(handle);
  }, [searchQuery, runSearch]);

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
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSettings, showAbout]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    runSearch(searchQuery);
  };

  const openResult = async (path: string) => {
    try {
      await openPath(path);
    } catch (error) {
      console.error("Failed to open file:", error);
    }
  };

  const saveShortcut = (e: React.FormEvent) => {
    e.preventDefault();
    if (tempShortcut.trim()) {
      setShortcut(tempShortcut.trim());
      setTempShortcut("");
    }
  };

  const handleDelete = async () => {
    if (!selectedResult) return;
    try {
      await invoke("delete_file", { path: selectedResult.path });
      setResults((prev) => prev.filter((r) => r.id !== selectedResult.id));
      setSelectedResult(null);
    } catch (error) {
      console.error("Failed to delete file:", error);
    }
  };

  const handleCopyPath = () => {
    if (selectedResult && navigator.clipboard) {
      navigator.clipboard.writeText(selectedResult.path);
    }
  };

  const getFilteredResults = () => {
    if (activeCategory === "All") return results;
    return results.filter((r) => {
      const ext = r.path.split(".").pop()?.toLowerCase() || "";
      const isPathDownloads = r.path.toLowerCase().includes("downloads");
      switch (activeCategory) {
        case "Music":
          return ["mp3", "wav", "flac", "ogg", "m4a"].includes(ext);
        case "Videos":
          return ["mp4", "mkv", "avi", "mov", "webm"].includes(ext);
        case "Programs":
          return ["exe", "msi", "bat", "cmd", "app", "sh"].includes(ext);
        case "Downloads":
          return isPathDownloads;
        default:
          return true;
      }
    });
  };

  const filteredResults = getFilteredResults();

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
              <div className="menu-dropdown-item">
                New Search <span style={{ opacity: 0.5 }}>Ctrl+N</span>
              </div>
              <div className="menu-dropdown-divider"></div>
              <div className="menu-dropdown-item" onClick={() => {}}>
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
              <div className="menu-dropdown-item">
                Copy <span style={{ opacity: 0.5 }}>Ctrl+C</span>
              </div>
              <div className="menu-dropdown-item">
                Paste <span style={{ opacity: 0.5 }}>Ctrl+V</span>
              </div>
              <div className="menu-dropdown-divider"></div>
              <div className="menu-dropdown-item">
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
            </div>
          )}
        </div>
      </div>

      {/* 2. Toolbar */}
      <div className="toolbar">
        <form className="search-wrapper" onSubmit={handleSearch}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            type="text"
            placeholder="Search documents, folders, files..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoFocus
          />
        </form>

        <div className="toolbar-divider"></div>

        <div className="toolbar-tabs">
          <div
            className={`toolbar-tab ${activeCategory === "Music" ? "active" : ""}`}
            onClick={() => setActiveCategory("Music")}
          >
            <svg
              width="14"
              height="14"
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
          </div>
          <div
            className={`toolbar-tab ${activeCategory === "Videos" ? "active" : ""}`}
            onClick={() => setActiveCategory("Videos")}
          >
            <svg
              width="14"
              height="14"
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
          </div>
          <div
            className={`toolbar-tab ${activeCategory === "Programs" ? "active" : ""}`}
            onClick={() => setActiveCategory("Programs")}
          >
            <svg
              width="14"
              height="14"
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
          </div>
          <div
            className={`toolbar-tab ${activeCategory === "Downloads" ? "active" : ""}`}
            onClick={() => setActiveCategory("Downloads")}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            Downloads
          </div>
          <div
            className={`toolbar-tab ${activeCategory === "All" ? "active" : ""}`}
            onClick={() => setActiveCategory("All")}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>
            Show All
          </div>
        </div>

        <div className="toolbar-divider" style={{ marginLeft: "auto" }}></div>

        <div className="toolbar-group">
          <button
            className="tool-btn"
            disabled={!selectedResult}
            onClick={() => selectedResult && openResult(selectedResult.path)}
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

      {/* Info Bar */}
      <div className="info-bar">
        {filteredResults.length} items found. Showing {activeCategory}
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
            Indexing: {indexingProgress.toLocaleString()} files
          </span>
        )}
      </div>

      {/* Dynamic Scan Progress Bar */}
      {indexingProgress !== null && (
        <div className="progress-bar-container">
          <div className="progress-bar-fill"></div>
        </div>
      )}

      {/* 3. Main Content Grid */}
      <div className="main-content">
        {/* Results Panel (Left Side Now) */}
        <div
          className="results-panel"
          style={{ borderRight: "1px solid var(--surface-border)" }}
        >
          <div className="results-container">
            {isSearching ? (
              <div className="loading">
                <div className="spinner"></div>
                <span>Searching local vectors...</span>
              </div>
            ) : results.length > 0 ? (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Path</th>
                    <th>Snippet</th>
                    <th style={{ textAlign: "right" }}>Relevance</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredResults.map((result) => (
                    <tr
                      key={result.id}
                      className={
                        selectedResult?.id === result.id ? "selected" : ""
                      }
                      onClick={() => setSelectedResult(result)}
                      onDoubleClick={() => openResult(result.path)}
                    >
                      <td className="td-name">
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                        </svg>
                        {result.title}
                      </td>
                      <td title={result.path}>{result.path}</td>
                      <td>
                        <HighlightedSnippet
                          text={result.snippet || result.title}
                        />
                      </td>
                      <td className="td-relevance">{result.relevance}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="empty-state">
                <svg
                  className="empty-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                  <polyline points="14 2 14 8 20 8"></polyline>
                  <line x1="16" y1="13" x2="8" y2="13"></line>
                  <line x1="16" y1="17" x2="8" y2="17"></line>
                  <polyline points="10 9 9 9 8 9"></polyline>
                </svg>
                <p>Type a query to securely search your private documents.</p>
              </div>
            )}
          </div>
        </div>

        {/* Right Sidebar */}
        <aside className="right-sidebar">
          <div className="sidebar-box">
            <div className="sidebar-box-header">Live Radar</div>
            <div className="sidebar-box-content">
              {radarToast ? (
                <div
                  className="sidebar-item"
                  onClick={() => openResult(radarToast)}
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
                  {radarToast.split("\\").pop() || radarToast}
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
              <div className="sidebar-item">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="12" cy="12" r="10"></circle>
                  <polygon points="10 8 16 12 10 16 10 8"></polygon>
                </svg>
                Windows Media Player
              </div>
              <div className="sidebar-item">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                  <line x1="3" y1="9" x2="21" y2="9"></line>
                  <line x1="9" y1="21" x2="9" y2="9"></line>
                </svg>
                Solitaire
              </div>
              <div className="sidebar-item">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                  <polyline points="2 17 12 22 22 17"></polyline>
                  <polyline points="2 12 12 17 22 12"></polyline>
                </svg>
                Minesweeper
              </div>
              <div
                className="sidebar-item"
                style={{
                  backgroundColor: "rgba(0,120,212,0.1)",
                  borderLeft: "2px solid var(--brand-primary)",
                  fontWeight: 500,
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M12 19l7-7 3 3-7 7-3-3z"></path>
                  <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"></path>
                  <path d="M2 2l7.586 7.586"></path>
                  <circle cx="11" cy="11" r="2"></circle>
                </svg>
                Paint
              </div>
              <div
                className="sidebar-item"
                style={{
                  marginTop: "16px",
                  color: "var(--text-muted)",
                  fontSize: "0.7rem",
                  paddingLeft: "12px",
                }}
              >
                RECENT
              </div>
              {results.slice(0, 3).map((r, i) => (
                <div
                  key={i}
                  className="sidebar-item"
                  onClick={() => openResult(r.path)}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                  </svg>
                  {r.title}
                </div>
              ))}
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

            <button
              className="close-settings-btn"
              onClick={() => setShowSettings(false)}
            >
              Close
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
            <span className="radar-toast-filename">{radarToast}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
