import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSearchStore } from "../store/searchStore";
import type { SearchResult } from "../store/searchStore";
import { getPlatform } from "../lib/platform";
import type { Platform } from "../lib/platform";
import { confirmDelete } from "../lib/confirmDelete";
import { useUpdateInfo, openReleasePage } from "../lib/updates";
import { useThemeSync } from "../lib/useTheme";
import { UpdateBanner } from "../components/UpdateBanner";
import {
  ANDROID_EVENTS,
  TAURI_EVENTS,
  type AllFilesAccessDetail,
  type FolderPickErrorDetail,
  type FolderPickedDetail,
  type MobileRoot,
} from "./types";
import { hasAllFilesAccess, onNativeEvent, openAllFilesAccess } from "./native";
import { SearchTab } from "./tabs/SearchTab";
import { PicksTab } from "./tabs/PicksTab";
import { RecentTab } from "./tabs/RecentTab";
import { SettingsTab } from "./tabs/SettingsTab";
import { TrashPanel } from "../components/TrashPanel";
import { ActionSheet } from "./components/ActionSheet";
import type { ActionSheetAction } from "./components/ActionSheet";

type TabKey = "search" | "picks" | "recent" | "settings";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "search", label: "Search" },
  { key: "picks", label: "Picks" },
  { key: "recent", label: "Recent" },
  { key: "settings", label: "Settings" },
];

export const MobileApp = () => {
  // Theme must reach the DOM on mobile too (desktop previously owned this).
  useThemeSync();
  const [platform, setPlatform] = useState<Platform>("desktop");
  const [allFilesAccess, setAllFilesAccess] = useState<boolean | null>(null);
  const [mobileRoots, setMobileRoots] = useState<MobileRoot[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>("search");
  const [actionResult, setActionResult] = useState<SearchResult | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | undefined>(undefined);
  // Notify-only on mobile: the banner links to the release page in the
  // browser; installing stays manual (Play Store / sideloaded APK).
  const { info: updateInfo, dismiss: dismissUpdate } = useUpdateInfo();

  const setIndexingProgress = useSearchStore((s) => s.setIndexingProgress);
  const setDbTotalCount = useSearchStore((s) => s.setDbTotalCount);
  const loadMyPicks = useSearchStore((s) => s.loadMyPicks);
  const indexingProgress = useSearchStore((s) => s.indexingProgress);
  const dbTotalCount = useSearchStore((s) => s.dbTotalCount);
  const query = useSearchStore((s) => s.query);
  const activeCategory = useSearchStore((s) => s.activeCategory);
  const runSearch = useSearchStore((s) => s.runSearch);
  const showTrash = useSearchStore((s) => s.showTrash);
  const setShowTrash = useSearchStore((s) => s.setShowTrash);

  const refreshStats = useCallback(async () => {
    try {
      setDbTotalCount(await invoke<number>("get_index_stats"));
    } catch {
      // DB may be unavailable during first boot; ignore.
    }
  }, [setDbTotalCount]);

  const refreshRoots = useCallback(async () => {
    try {
      setMobileRoots(await invoke<MobileRoot[]>("get_mobile_roots"));
    } catch {
      // Roots are optional; ignore failures.
    }
  }, []);

  const triggerIndexing = useCallback(async () => {
    try {
      setIndexingProgress(0);
      const { customDirs, excludedDirs } = useSearchStore.getState();
      await invoke("start_indexing", { customDirs, excludedDirs });
    } catch (error) {
      setIndexingProgress(null);
      setToast(String(error));
    }
  }, [setIndexingProgress, setToast]);

  const addRootAndReindex = useCallback(
    async (path: string, name?: string) => {
      try {
        await invoke("add_mobile_root", { path, name });
        setToast(`Added folder: ${name ?? path}`);
        await refreshRoots();
        void triggerIndexing();
      } catch (error) {
        setToast(String(error));
      }
    },
    [refreshRoots, triggerIndexing, setToast],
  );

  const removeRoot = useCallback(
    async (path: string) => {
      try {
        setMobileRoots(
          await invoke<MobileRoot[]>("remove_mobile_root", { path }),
        );
        setToast("Folder removed");
      } catch (error) {
        setToast(String(error));
      }
    },
    [setToast],
  );

  // Native (Android bridge + iOS Rust) events and initial boot.
  useEffect(() => {
    let disposed = false;
    const unsubs: Array<() => void> = [];

    const boot = async () => {
      const p = await getPlatform();
      if (disposed) return;
      setPlatform(p);
      let canIndex = true;
      if (p === "android") {
        const granted = hasAllFilesAccess();
        setAllFilesAccess(granted);
        canIndex = granted;
        unsubs.push(
          onNativeEvent<FolderPickedDetail>(
            ANDROID_EVENTS.folderPicked,
            (d) => {
              void addRootAndReindex(d.path, d.name);
            },
          ),
          onNativeEvent<FolderPickErrorDetail>(
            ANDROID_EVENTS.folderPickError,
            (d) => setToast(d.error),
          ),
          onNativeEvent<AllFilesAccessDetail>(
            ANDROID_EVENTS.allFilesAccess,
            (d) => {
              setAllFilesAccess(d.granted);
              // First scan on Android can only happen once access is granted:
              // the indexer walks raw paths, which return nothing without it.
              if (d.granted) void triggerIndexing();
            },
          ),
        );
      }
      if (canIndex) void triggerIndexing();
    };
    void boot();

    void Promise.all([
      listen<number>(TAURI_EVENTS.mobileFilesImported, () => {
        void refreshRoots();
        void triggerIndexing();
        setToast("Imported files");
      }),
      listen<number>(TAURI_EVENTS.indexProgress, (e) => {
        setIndexingProgress(e.payload);
      }),
      listen<number>(TAURI_EVENTS.indexDone, () => {
        setIndexingProgress(null);
        void refreshStats();
        // A fresh scan means fresh browse sections when no query is active.
        if (!useSearchStore.getState().query.trim()) {
          void useSearchStore.getState().runBrowse();
        }
      }),
    ]).then((unlisten) => {
      if (disposed) {
        for (const f of unlisten) f();
        return;
      }
      unsubs.push(...unlisten);
    });

    return () => {
      disposed = true;
      for (const f of unsubs) f();
    };
  }, [
    addRootAndReindex,
    refreshRoots,
    refreshStats,
    triggerIndexing,
    setIndexingProgress,
    setToast,
  ]);

  // Initial stats + roots. Indexing is kicked off from `boot` (and, on Android,
  // only once All Files Access is confirmed) so we never scan an empty device.
  useEffect(() => {
    void refreshStats();
    // The setter runs after an awaited invoke, not synchronously in the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshRoots();
    void loadMyPicks();
  }, [refreshStats, refreshRoots, loadMyPicks]);

  // Debounced live search.
  useEffect(() => {
    void runSearch(query);
  }, [query, activeCategory, runSearch]);

  // Toast auto-dismiss.
  useEffect(() => {
    if (!toast) return;
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(toastTimerRef.current);
  }, [toast]);

  const buildActions = useCallback(
    (result: SearchResult): ActionSheetAction[] => {
      const store = useSearchStore.getState();
      const pinned = store.myPicks.some((p) => p.id === result.id);
      return [
        {
          label: "Open",
          onSelect: () => {
            void store.openResult(result);
          },
        },
        {
          label: "Copy Path",
          onSelect: () => {
            if (!navigator.clipboard) {
              setToast("Clipboard unavailable");
              return;
            }
            void navigator.clipboard.writeText(result.path).then(
              () => setToast("Path copied"),
              () => setToast("Could not copy path"),
            );
          },
        },
        {
          label: pinned ? "Unpin from My Picks" : "Pin to My Picks",
          onSelect: () => {
            if (pinned) {
              store.removeMyPick(result.id);
            } else {
              store.addMyPick(result);
            }
          },
        },
        {
          label: "Delete",
          danger: true,
          onSelect: () => {
            void (async () => {
              if (!(await confirmDelete(result.title, result.path))) return;
              try {
                await invoke("delete_file", { path: result.path });
              } catch (error) {
                setToast(String(error));
                return;
              }
              // Keep the backend's My Picks in step, or the row returns on the
              // next load (same reason as the desktop handler).
              try {
                await invoke("remove_my_pick", { id: result.id });
              } catch (error) {
                console.error("Failed to remove pick record:", error);
              }
              try {
                const s = useSearchStore.getState();
                useSearchStore.setState({
                  results: s.results.filter((r) => r.id !== result.id),
                  browseSections: s.browseSections.map((section) => ({
                    ...section,
                    files: section.files.filter((r) => r.id !== result.id),
                  })),
                  myPicks: s.myPicks.filter((p) => p.id !== result.id),
                  recentItems: s.recentItems.filter((r) => r.id !== result.id),
                });
                setToast("File deleted");
              } catch (error) {
                setToast(String(error));
              }
            })();
          },
        },
      ];
    },
    [setToast],
  );

  const openActionsFor = useCallback((result: SearchResult) => {
    setActionResult(result);
  }, []);

  const tabIcon = (key: TabKey) => {
    const common = {
      width: 20,
      height: 20,
      viewBox: "0 0 24 24",
      fill: "none" as const,
      stroke: "currentColor",
      strokeWidth: 2,
    };
    switch (key) {
      case "search":
        return (
          <svg {...common}>
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
        );
      case "picks":
        return (
          <svg {...common}>
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
          </svg>
        );
      case "recent":
        return (
          <svg {...common}>
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
        );
      case "settings":
        return (
          <svg {...common}>
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
        );
    }
  };

  return (
    <div className="mob-app">
      <header className="mob-header">
        <span className="mob-brand">Vexil</span>
        <span className="mob-header-meta">
          {dbTotalCount.toLocaleString()} files indexed
          {indexingProgress !== null && (
            <span className="mob-scanning">
              {" "}
              · scanning {indexingProgress.toLocaleString()}
            </span>
          )}
        </span>
      </header>

      {updateInfo && (
        <UpdateBanner
          info={updateInfo}
          actionLabel="Download"
          onAction={() => void openReleasePage(updateInfo)}
          onDismiss={dismissUpdate}
        />
      )}

      {platform === "android" && allFilesAccess === false && (
        <div className="mob-permission-banner" role="alert">
          <span>Allow file access to search this device.</span>
          <button
            type="button"
            className="mob-btn"
            onClick={openAllFilesAccess}
          >
            Allow Access
          </button>
        </div>
      )}

      <main className="mob-main">
        {activeTab === "search" && <SearchTab onLongPress={openActionsFor} />}
        {activeTab === "picks" && <PicksTab onLongPress={openActionsFor} />}
        {activeTab === "recent" && <RecentTab onLongPress={openActionsFor} />}
        {activeTab === "settings" && (
          <SettingsTab
            platform={platform}
            allFilesAccess={allFilesAccess}
            roots={mobileRoots}
            onRemoveRoot={(path) => void removeRoot(path)}
            onReindex={() => void triggerIndexing()}
            onToast={setToast}
          />
        )}
      </main>

      <nav className="mob-tabbar" aria-label="Primary">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`mob-tab${activeTab === tab.key ? " active" : ""}`}
            onClick={() => setActiveTab(tab.key)}
            aria-current={activeTab === tab.key ? "page" : undefined}
          >
            {tabIcon(tab.key)}
            <span>{tab.label}</span>
          </button>
        ))}
      </nav>

      {showTrash && (
        <TrashPanel
          onClose={() => setShowTrash(false)}
          onChanged={() => {
            void runSearch(query);
            void useSearchStore.getState().runBrowse();
          }}
        />
      )}

      {actionResult && (
        <ActionSheet
          open
          title={actionResult.title}
          actions={buildActions(actionResult)}
          onClose={() => setActionResult(null)}
        />
      )}

      {toast && (
        <div className="mob-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
};

export default MobileApp;
