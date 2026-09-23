import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";

export interface SearchResult {
  id: number;
  title: string;
  snippet: string;
  path: string;
  relevance: number;
  size: number;
  modified: number;
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
  activeCategory: string;
  activeSizeFilter: string;
  activeDateFilter: string;
  selectedResult: SearchResult | null;
  myPicks: SearchResult[];
  recentItems: SearchResult[];
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
  setActiveCategory: (category: string) => void;
  setActiveSizeFilter: (filter: string) => void;
  setActiveDateFilter: (filter: string) => void;
  setSelectedResult: (result: SearchResult | null) => void;
  addMyPick: (pick: SearchResult) => void;
  removeMyPick: (id: number) => void;
  addRecentItem: (item: SearchResult) => void;
  setRadarToast: (toast: string | null) => void;
  setCustomDirs: (dirs: string[] | ((prev: string[]) => string[])) => void;
  setExcludedDirs: (dirs: string[] | ((prev: string[]) => string[])) => void;
  setTheme: (theme: "system" | "light" | "dark") => void;
  setShortcut: (shortcut: string) => void;
  setShowSettings: (show: boolean) => void;
  setShowAbout: (show: boolean) => void;
  setActiveMenu: (menu: string | null) => void;
  openResult: (result: SearchResult) => void;
  openInExplorer: (path: string) => void;
}

export const useSearchStore = create<SearchState>()(
  persist(
    (set) => ({
      query: "",
      results: [],
      isSearching: false,
      indexingProgress: null,
      activeCategory: "All",
      activeSizeFilter: "Any Size",
      activeDateFilter: "Any Time",
      selectedResult: null,
      myPicks: [],
      recentItems: [],
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
      openResult: async (result) => {
        try {
          await openPath(result.path);
        } catch (e) {
          console.error("openPath failed", e);
          await invoke("open_in_explorer", { path: result.path }).catch(
            console.error,
          );
        }
        set((state) => ({
          selectedResult: result,
          recentItems: [
            result,
            ...state.recentItems.filter((r) => r.id !== result.id),
          ].slice(0, 5),
        }));
      },
      openInExplorer: async (path) => {
        await invoke("open_in_explorer", { path }).catch(console.error);
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
