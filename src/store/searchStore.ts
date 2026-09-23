import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";

let searchSeq = 0;
let searchTimer: number | undefined;

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

export interface DirEntry {
  name: string;
  path: string;
}

export type Theme = "system" | "light" | "dark";

interface SearchState {
  query: string;
  results: SearchResult[];
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
  activeMenu: string | null;

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
  addMyPick: (pick: SearchResult) => void;
  removeMyPick: (id: number) => void;
  addRecentItem: (item: SearchResult) => void;
  setRadarFiles: (paths: string[]) => void;
  setRadarToast: (toast: string | null) => void;
  setCustomDirs: (dirs: string[] | ((prev: string[]) => string[])) => void;
  setExcludedDirs: (dirs: string[] | ((prev: string[]) => string[])) => void;
  setTheme: (theme: "system" | "light" | "dark") => void;
  setShortcut: (shortcut: string) => void;
  setShowSettings: (show: boolean) => void;
  setShowAbout: (show: boolean) => void;
  setActiveMenu: (menu: string | null) => void;
  openResult: (result: SearchResult | string) => void;
  openInExplorer: (path: string) => void;
  runSearch: (query: string, immediate?: boolean) => Promise<void>;
  handleCopyPath: () => void;
  handleDelete: () => Promise<void>;
}

export const useSearchStore = create<SearchState>()(
  persist(
    (set, get) => ({
      query: "",
      results: [],
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
      addMyPick: (pick) =>
        set((state) => ({
          myPicks: state.myPicks.some((p) => p.id === pick.id)
            ? state.myPicks
            : [...state.myPicks, pick],
        })),
      removeMyPick: (id) =>
        set((state) => ({
          myPicks: state.myPicks.filter((p) => p.id !== id),
        })),
      addRecentItem: (item) =>
        set((state) => ({
          recentItems: [
            item,
            ...state.recentItems.filter((r) => r.id !== item.id),
          ].slice(0, 5),
        })),
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
      openResult: async (item) => {
        const path = typeof item === "string" ? item : item.path;
        try {
          await openPath(path);
        } catch (e) {
          console.error("openPath failed", e);
          try {
            await invoke("open_in_explorer", { path });
          } catch (explorerError) {
            console.error("open_in_explorer failed", explorerError);
            alert(`Could not open: ${path}`);
          }
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
          alert(`Could not reveal: ${path}`);
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
          return;
        }
        set({ isSearching: true });
        const run = async () => {
          try {
            const results = await invoke<SearchResult[]>("search_files", {
              query,
              category: get().activeCategory,
            });
            if (searchSeq !== seq) return;
            set({ results, isSearching: false });
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
      handleDelete: async () => {
        const selected = get().selectedResult;
        if (!selected) return;
        try {
          await invoke("delete_file", { path: selected.path });
          set((state) => ({
            results: state.results.filter((r) => r.id !== selected.id),
            myPicks: state.myPicks.filter((p) => p.id !== selected.id),
            recentItems: state.recentItems.filter((r) => r.id !== selected.id),
            selectedResult: null,
          }));
        } catch (error) {
          console.error("Failed to delete file:", error);
        }
      },
    }),
    {
      name: "vexil-storage",
      partialize: (state) => ({
        myPicks: state.myPicks,
        recentItems: state.recentItems,
        theme: state.theme,
        shortcut: state.shortcut,
        customDirs: state.customDirs,
        excludedDirs: state.excludedDirs,
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
