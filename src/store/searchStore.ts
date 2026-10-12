import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import { openFileExternally } from "../lib/openExternal";
import { confirmDelete } from "../lib/confirmDelete";
import { FEATURES, hasFeature } from "./licenseStore";

let searchSeq = 0;
let searchTimer: number | undefined;
let browseSeq = 0;

export interface SearchResult {
  id: number;
  title: string;
  snippet: string;
  path: string;
  relevance: number;
  size: number;
  modified: number;
  category: string;
}

export interface BrowseSection {
  category: string;
  count: number;
  files: SearchResult[];
}

export interface DirEntry {
  name: string;
  path: string;
}

export type Theme = "system" | "light" | "dark";

interface SearchState {
  query: string;
  results: SearchResult[];
  browseSections: BrowseSection[];
  isSearching: boolean;
  indexingProgress: number | null;
  dbTotalCount: number;
  activeCategory: string;
  activeSizeFilter: string;
  activeDateFilter: string;
  selectedResult: SearchResult | null;
  myPicks: SearchResult[];
  recentItems: SearchResult[];
  radarFiles: string[];
  radarToast: string | null;
  customDirs: string[];
  excludedDirs: string[];
  theme: "system" | "light" | "dark";
  shortcut: string;
  showSettings: boolean;
  showAbout: boolean;
  showTrash: boolean;
  activeMenu: string | null;
  runInBackground: boolean;

  // Actions
  setQuery: (query: string) => void;
  setResults: (results: SearchResult[]) => void;
  setIsSearching: (isSearching: boolean) => void;
  setIndexingProgress: (progress: number | null) => void;
  setDbTotalCount: (count: number) => void;
  setActiveCategory: (category: string) => void;
  setActiveSizeFilter: (filter: string) => void;
  setActiveDateFilter: (filter: string) => void;
  setSelectedResult: (result: SearchResult | null) => void;
  loadMyPicks: () => Promise<void>;
  addMyPick: (pick: SearchResult) => Promise<void>;
  removeMyPick: (id: number) => Promise<void>;
  setRadarFiles: (paths: string[]) => void;
  setRadarToast: (toast: string | null) => void;
  setCustomDirs: (dirs: string[] | ((prev: string[]) => string[])) => void;
  setExcludedDirs: (dirs: string[] | ((prev: string[]) => string[])) => void;
  setTheme: (theme: "system" | "light" | "dark") => void;
  setShortcut: (shortcut: string) => void;
  setShowSettings: (show: boolean) => void;
  setShowAbout: (show: boolean) => void;
  setShowTrash: (show: boolean) => void;
  setRunInBackground: (run: boolean) => void;
  setActiveMenu: (menu: string | null) => void;
  openResult: (result: SearchResult | string) => void;
  openInExplorer: (path: string) => void;
  runSearch: (query: string, immediate?: boolean) => Promise<void>;
  runBrowse: () => Promise<void>;
  handleCopyPath: () => void;
  handleDelete: () => Promise<void>;
}

/** Reads backend picks, treating a null/undefined reply as "no picks". */
const readPicks = async (): Promise<SearchResult[]> => {
  const rows = await invoke<SearchResult[] | null>("list_my_picks");
  return Array.isArray(rows) ? rows : [];
};

export const useSearchStore = create<SearchState>()(
  persist(
    (set, get) => ({
      query: "",
      results: [],
      browseSections: [],
      isSearching: false,
      indexingProgress: null,
      dbTotalCount: 0,
      activeCategory: "All",
      activeSizeFilter: "Any Size",
      activeDateFilter: "Any Time",
      selectedResult: null,
      myPicks: [],
      recentItems: [],
      radarFiles: [],
      radarToast: null,
      customDirs: [],
      excludedDirs: [],
      theme: "system",
      shortcut: "CommandOrControl+Shift+Space",
      showSettings: false,
      showAbout: false,
      showTrash: false,
      runInBackground: false,
      activeMenu: null,

      setQuery: (query) => set({ query }),
      setActiveMenu: (activeMenu) => set({ activeMenu }),
      setResults: (results) => set({ results, selectedResult: null }),
      setIsSearching: (isSearching) => set({ isSearching }),
      setIndexingProgress: (indexingProgress) => set({ indexingProgress }),
      setDbTotalCount: (dbTotalCount) => set({ dbTotalCount }),
      setActiveCategory: (activeCategory) => set({ activeCategory }),
      setActiveSizeFilter: (activeSizeFilter) => set({ activeSizeFilter }),
      setActiveDateFilter: (activeDateFilter) => set({ activeDateFilter }),
      setSelectedResult: (selectedResult) => set({ selectedResult }),

      /**
       * My Picks live in SQLite so the free-tier cap is enforced by the
       * backend rather than by an edit to local storage. Anything still sitting
       * in the persisted store is pushed across once, then dropped.
       */
      loadMyPicks: async () => {
        const legacy: SearchResult[] = get().myPicks;
        try {
          let picks = await readPicks();

          if (legacy.length > 0) {
            for (const pick of legacy) {
              try {
                await invoke("add_my_pick", { pick });
              } catch (error) {
                // A legacy free-tier user may exceed the cap; keep what fits
                // and drop the rest rather than failing the whole migration.
                console.warn("Could not migrate pick:", error);
              }
            }
            picks = await readPicks();
          }

          set({ myPicks: picks });
        } catch (error) {
          console.error("Failed to load My Picks:", error);
        }
      },
      addMyPick: async (pick) => {
        if (get().myPicks.some((p) => p.id === pick.id)) {
          return;
        }
        try {
          await invoke("add_my_pick", { pick });
          set({ myPicks: await invoke<SearchResult[]>("list_my_picks") });
        } catch (error) {
          void message(String(error));
        }
      },
      removeMyPick: async (id) => {
        const previous = get().myPicks;
        set({ myPicks: previous.filter((p) => p.id !== id) });
        try {
          await invoke("remove_my_pick", { id });
        } catch (error) {
          console.error("Failed to remove pick:", error);
          set({ myPicks: previous });
        }
      },
      setRadarFiles: (radarFiles) => set({ radarFiles }),
      setRadarToast: (radarToast) => set({ radarToast }),
      setCustomDirs: (customDirs) =>
        set((state) => ({
          customDirs:
            typeof customDirs === "function"
              ? customDirs(state.customDirs)
              : customDirs,
        })),
      setExcludedDirs: (excludedDirs) =>
        set((state) => ({
          excludedDirs:
            typeof excludedDirs === "function"
              ? excludedDirs(state.excludedDirs)
              : excludedDirs,
        })),
      setTheme: (theme) => set({ theme }),
      setShortcut: (shortcut) => set({ shortcut }),
      setShowSettings: (showSettings) => set({ showSettings }),
      setShowAbout: (showAbout) => set({ showAbout }),
      setShowTrash: (showTrash) => set({ showTrash }),
      setRunInBackground: (runInBackground) => {
        if (runInBackground && !hasFeature(FEATURES.background)) {
          void message("Running in background is a Pro feature.");
          return;
        }
        set({ runInBackground });
        invoke("set_run_in_background", { enable: runInBackground }).catch(
          console.error,
        );
      },
      openResult: async (item) => {
        const path = typeof item === "string" ? item : item.path;
        const error = await openFileExternally(path);
        if (error) {
          console.error("open failed", error);
          await message(error);
        }
        if (typeof item !== "string") {
          set((state) => ({
            selectedResult: item,
            recentItems: [
              item,
              ...state.recentItems.filter((r) => r.id !== item.id),
            ].slice(0, 5),
          }));
        }
      },
      openInExplorer: async (path) => {
        try {
          await invoke("open_in_explorer", { path });
        } catch (error) {
          console.error("Failed to reveal in explorer:", error);
          void message(`Could not reveal: ${path}`);
        }
      },
      runSearch: async (query, immediate = false) => {
        const seq = ++searchSeq;
        if (searchTimer !== undefined) {
          window.clearTimeout(searchTimer);
          searchTimer = undefined;
        }
        if (!query.trim()) {
          set({ results: [], isSearching: false });
          void get().runBrowse();
          return;
        }
        set({ isSearching: true, browseSections: [] });
        const run = async () => {
          try {
            const results = await invoke<SearchResult[]>("search_files", {
              query,
              category: get().activeCategory,
            });
            if (searchSeq !== seq) return;
            set({ results, isSearching: false, selectedResult: null });
          } catch (error) {
            if (searchSeq !== seq) return;
            console.error("Failed to search files:", error);
            set({ isSearching: false });
          }
        };
        if (immediate) {
          await run();
        } else {
          searchTimer = window.setTimeout(run, 250);
        }
      },
      handleCopyPath: () => {
        const selected = get().selectedResult;
        if (selected && navigator.clipboard) {
          navigator.clipboard.writeText(selected.path).catch(console.error);
        }
      },
      runBrowse: async () => {
        const seq = ++browseSeq;
        set({ isSearching: false });
        try {
          const sections = await invoke<unknown>("browse_files", {
            category: get().activeCategory,
          });
          if (browseSeq !== seq) return;
          set({
            browseSections: Array.isArray(sections)
              ? (sections as BrowseSection[])
              : [],
            selectedResult: null,
          });
        } catch (error) {
          if (browseSeq !== seq) return;
          console.error("Failed to load browse sections:", error);
          set({ browseSections: [] });
        }
      },
      handleDelete: async () => {
        const selected = get().selectedResult;
        if (!selected) return;
        if (!(await confirmDelete(selected.title, selected.path))) return;
        try {
          await invoke("delete_file", { path: selected.path });
        } catch (error) {
          console.error("Failed to delete file:", error);
          return;
        }
        // The pick is owned by SQLite, so the local filter below is not enough:
        // without this the deleted file reappears in My Picks on the next load.
        try {
          await invoke("remove_my_pick", { id: selected.id });
        } catch (error) {
          console.error("Failed to remove pick record:", error);
        }
        set((state) => ({
          results: state.results.filter((r) => r.id !== selected.id),
          browseSections: state.browseSections.map((section) => ({
            ...section,
            files: section.files.filter((r) => r.id !== selected.id),
          })),
          myPicks: state.myPicks.filter((p) => p.id !== selected.id),
          recentItems: state.recentItems.filter((r) => r.id !== selected.id),
          selectedResult: null,
        }));
      },
    }),
    {
      name: "vexil-storage",
      partialize: (state) => ({
        // My Picks are intentionally absent: they are owned by the backend now,
        // which is what enforces the free-tier cap. Leaving them here would
        // re-run the one-time migration on every launch.
        recentItems: state.recentItems,
        theme: state.theme,
        shortcut: state.shortcut,
        customDirs: state.customDirs,
        excludedDirs: state.excludedDirs,
        runInBackground: state.runInBackground,
      }),
    },
  ),
);

if (typeof localStorage !== "undefined") {
  const oldRecent = localStorage.getItem("vexil-recent");
  const oldPicks = localStorage.getItem("vexil-picks");

  if (oldRecent || oldPicks) {
    try {
      const recent = oldRecent ? JSON.parse(oldRecent) : [];
      const picks = oldPicks ? JSON.parse(oldPicks) : [];

      useSearchStore.setState((state) => ({
        recentItems: [...recent, ...state.recentItems]
          .filter((v, i, a) => a.findIndex((t) => t.id === v.id) === i)
          .slice(0, 5),
        myPicks: [...picks, ...state.myPicks].filter(
          (v, i, a) => a.findIndex((t) => t.id === v.id) === i,
        ),
      }));

      localStorage.removeItem("vexil-recent");
      localStorage.removeItem("vexil-picks");
    } catch (e) {
      console.error("Failed to migrate old data", e);
    }
  }
}
