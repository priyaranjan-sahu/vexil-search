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

interface DirEntry {
  name: string;
  path: string;
}

const TreeNode = ({
  path,
  name,
  customDirs,
  setCustomDirs,
  excludedDirs,
  setExcludedDirs,
  isRoot = false,
  parentIsChecked = false,
}: {
  path: string;
  name: string;
  customDirs: string[];
  setCustomDirs: React.Dispatch<React.SetStateAction<string[]>>;
  excludedDirs: string[];
  setExcludedDirs: React.Dispatch<React.SetStateAction<string[]>>;
  isRoot?: boolean;
  parentIsChecked?: boolean;
}) => {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const isExplicitlyChecked = customDirs.includes(path);
  const isExplicitlyExcluded = excludedDirs.includes(path);
  const isEffectivelyChecked =
    (isExplicitlyChecked || parentIsChecked) && !isExplicitlyExcluded;

  const toggleExpand = async () => {
    if (!expanded && children.length === 0) {
      setLoading(true);
      try {
        const subdirs = await invoke<DirEntry[]>("get_directories", { path });
        setChildren(subdirs);
      } catch (e) {
        console.error(e);
      }
      setLoading(false);
    }
    setExpanded(!expanded);
  };

  const toggleCheck = () => {
    if (parentIsChecked) {
      if (isEffectivelyChecked) {
        // Exclude it
        setExcludedDirs((prev) => [...prev, path]);
      } else {
        // Re-include it
        setExcludedDirs((prev) => prev.filter((p) => p !== path));
      }
    } else {
      if (isEffectivelyChecked) {
        // Uncheck it explicitly
        setCustomDirs((prev) => prev.filter((p) => p !== path));
      } else {
        // Check it explicitly
        setCustomDirs((prev) => [...prev, path]);
        setExcludedDirs((prev) => prev.filter((p) => p !== path));
      }
    }
  };

  return (
    <div style={{ marginLeft: isRoot ? 0 : 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "4px 0",
        }}
      >
        <button
          onClick={toggleExpand}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            width: "20px",
            padding: 0,
            color: "var(--text-secondary)",
          }}
        >
          {loading ? "⏳" : expanded ? "▼" : "▶"}
        </button>
        <input
          type="checkbox"
          checked={isEffectivelyChecked}
          onChange={toggleCheck}
        />
        <span
          style={{
            fontSize: "0.9rem",
            cursor: "default",
            color: "var(--text-primary)",
          }}
          onDoubleClick={toggleExpand}
        >
          {name}
        </span>
      </div>
      {expanded && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.path}
              path={child.path}
              name={child.name}
              customDirs={customDirs}
              setCustomDirs={setCustomDirs}
              excludedDirs={excludedDirs}
              setExcludedDirs={setExcludedDirs}
              parentIsChecked={isEffectivelyChecked}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const DirectoryTree = ({
  customDirs,
  setCustomDirs,
  excludedDirs,
  setExcludedDirs,
}: {
  customDirs: string[];
  setCustomDirs: React.Dispatch<React.SetStateAction<string[]>>;
  excludedDirs: string[];
  setExcludedDirs: React.Dispatch<React.SetStateAction<string[]>>;
}) => {
  const [drives, setDrives] = useState<string[]>([]);

  useEffect(() => {
    invoke<string[]>("get_system_drives").then(setDrives).catch(console.error);
  }, []);

  return (
    <div
      style={{
        maxHeight: "300px",
        overflowY: "auto",
        background: "var(--surface-color)",
        border: "1px solid var(--surface-border)",
        borderRadius: "6px",
        padding: "8px",
        textAlign: "left",
      }}
    >
      {drives.length === 0 && (
        <div style={{ color: "var(--text-muted)" }}>Loading drives...</div>
      )}
      {drives.map((drive) => (
        <TreeNode
          key={drive}
          path={drive}
          name={drive}
          customDirs={customDirs}
          setCustomDirs={setCustomDirs}
          excludedDirs={excludedDirs}
          setExcludedDirs={setExcludedDirs}
          isRoot={true}
        />
      ))}
    </div>
  );
};

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
  const [activeSizeFilter, setActiveSizeFilter] = useState<string>("Any Size");
  const [activeDateFilter, setActiveDateFilter] = useState<string>("Any Time");
  const [activeMenu, setActiveMenu] = useState<string | null>(null);

  // Ava Find Features (Renamed to avoid copy)
  const [selectedResult, setSelectedResult] = useState<SearchResult | null>(
    null,
  );
  const [radarToast, setRadarToast] = useState<string | null>(null);

  const [myPicks, setMyPicks] = useState<SearchResult[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("vexil-picks") || "[]");
    } catch {
      return [];
    }
  });
  const [recentItems, setRecentItems] = useState<SearchResult[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("vexil-recent") || "[]");
    } catch {
      return [];
    }
  });
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    result: SearchResult;
  } | null>(null);

  useEffect(() => {
    localStorage.setItem("vexil-picks", JSON.stringify(myPicks));
  }, [myPicks]);

  useEffect(() => {
    localStorage.setItem("vexil-recent", JSON.stringify(recentItems));
  }, [recentItems]);

  // Close context menu on click anywhere
  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener("click", closeMenu);
    return () => window.removeEventListener("click", closeMenu);
  }, []);

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
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Theme Engine
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    if (theme !== "system") {
      root.classList.add(theme);
    }
    localStorage.setItem("vexil-theme", theme);
  }, [theme]);

  const [customDirs, setCustomDirs] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("vexil-custom-dirs") || "[]");
    } catch {
      return [];
    }
  });

  const [excludedDirs, setExcludedDirs] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("vexil-excluded-dirs") || "[]");
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem("vexil-custom-dirs", JSON.stringify(customDirs));
  }, [customDirs]);

  useEffect(() => {
    localStorage.setItem("vexil-excluded-dirs", JSON.stringify(excludedDirs));
  }, [excludedDirs]);

  const triggerIndexing = useCallback(() => {
    invoke("start_indexing", { customDirs, excludedDirs });
  }, [customDirs, excludedDirs]);

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

    triggerIndexing();

    return () => {
      unlistenProgress.then((f) => f());
      unlistenDone.then((f) => f());
      unlistenRadar.then((f) => f());
    };
  }, [triggerIndexing]);

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

  const openResult = async (item: SearchResult | string) => {
    try {
      const path = typeof item === "string" ? item : item.path;
      await openPath(path);

      if (typeof item !== "string") {
        setRecentItems((prev) => {
          const next = [item, ...prev.filter((r) => r.id !== item.id)].slice(
            0,
            5,
          );
          return next;
        });
      }
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
                      onDoubleClick={() => openResult(result)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setSelectedResult(result);
                        setContextMenu({ x: e.clientX, y: e.clientY, result });
                      }}
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
              <DirectoryTree
                customDirs={customDirs}
                setCustomDirs={setCustomDirs}
                excludedDirs={excludedDirs}
                setExcludedDirs={setExcludedDirs}
              />
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
              setMyPicks((prev) => {
                if (prev.some((p) => p.id === res.id)) {
                  return prev.filter((p) => p.id !== res.id);
                }
                return [...prev, res];
              });
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
            <span className="radar-toast-filename">{radarToast}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
