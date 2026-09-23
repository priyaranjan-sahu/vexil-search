import { create } from "zustand";
import { persist } from "zustand/middleware";

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
  setCustomDirs: (dirs: string[]) => void;
  setExcludedDirs: (dirs: string[]) => void;
  setTheme: (theme: "system" | "light" | "dark") => void;
  setShortcut: (shortcut: string) => void;
  setShowSettings: (show: boolean) => void;
  setShowAbout: (show: boolean) => void;
  setActiveMenu: (menu: string | null) => void;
  openResult: (result: SearchResult) => void;
  handleCopyPath: () => void;
  handleDelete: () => void;
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
      setCustomDirs: (customDirs) => set({ customDirs }),
      setExcludedDirs: (excludedDirs) => set({ excludedDirs }),
      setTheme: (theme) => set({ theme }),
      setShortcut: (shortcut) => set({ shortcut }),
      setShowSettings: (showSettings) => set({ showSettings }),
      setShowAbout: (showAbout) => set({ showAbout }),
      openResult: (result) => set({ selectedResult: result }),
      handleCopyPath: () => set({}), // No state change needed
      handleDelete: () => set({}), // No state change needed
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
