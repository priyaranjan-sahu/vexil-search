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

  // Settings & Theme
  const [showSettings, setShowSettings] = useState(false);
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

    invoke("start_indexing");

    return () => {
      unlistenProgress.then((f) => f());
      unlistenDone.then((f) => f());
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

  // Escape clears the query / closes settings
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showSettings) {
          setShowSettings(false);
        } else {
          setSearchQuery("");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSettings]);

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

  return (
    <div className="container">
      {/* Header */}
      <header className="header">
        <div className="header-top">
          <div className="logo-container">
            <svg
              className="logo-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path>
            </svg>
            <h1>Vexil Search</h1>
          </div>
        </div>

        <div className="header-status">
          {indexingProgress !== null ? (
            <div className="indexing-indicator">
              <span className="spinner"></span> Cache Building:{" "}
              {indexingProgress.toLocaleString()} files
            </div>
          ) : (
            <span>Ready</span>
          )}
        </div>
      </header>

      {/* Main Layout Grid */}
      <main className="main-content">
        {/* Sidebar */}
        <aside className="sidebar">
          <div className="sidebar-section">
            <h3 className="sidebar-title">Filters</h3>
            <div className="filter-group">
              <label className="filter-item active">
                <input type="checkbox" defaultChecked />
                All Files
              </label>
              <label className="filter-item">
                <input type="checkbox" />
                Documents
              </label>
              <label className="filter-item">
                <input type="checkbox" />
                Images
              </label>
            </div>
          </div>

          <div className="sidebar-section">
            <h3 className="sidebar-title">Settings</h3>
            <button
              className="settings-btn"
              onClick={() => setShowSettings(true)}
              style={{
                width: "100%",
                justifyContent: "flex-start",
                gap: "8px",
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l.06-.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
              Preferences
            </button>
          </div>
        </aside>

        {/* Results Panel */}
        <section className="results-panel">
          <div className="search-bar-wrapper">
            <form className="search-form" onSubmit={handleSearch}>
              <div className="input-wrapper">
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
                  type="text"
                  placeholder="Search your documents, folders, and files..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  autoFocus
                />
              </div>
            </form>
          </div>

          <div className="results-header">
            <div className="results-info">
              Showing <span className="results-count">{results.length}</span>{" "}
              local results
            </div>
          </div>

          <div className="results-container">
            {isSearching ? (
              <div className="loading">
                <div className="spinner"></div>
                <span>Searching local vectors...</span>
              </div>
            ) : results.length > 0 ? (
              <ul className="results-list">
                {results.map((result) => (
                  <li
                    key={result.id}
                    className="result-item"
                    onClick={() => openResult(result.path)}
                    title={result.path}
                  >
                    <div className="result-icon">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                      </svg>
                    </div>
                    <div className="result-content">
                      <div className="result-title-row">
                        <span className="result-title">
                          <HighlightedSnippet
                            text={result.snippet || result.title}
                          />
                        </span>
                        <span className="result-relevance">
                          {result.relevance}%
                        </span>
                      </div>
                      <span className="result-path">{result.path}</span>
                    </div>
                  </li>
                ))}
              </ul>
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
        </section>
      </main>

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
    </div>
  );
}

export default App;
