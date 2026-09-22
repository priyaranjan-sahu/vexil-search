import { create } from "zustand";

export interface SearchResult {
  id: number;
  title: string;
  snippet: string;
  path: string;
  relevance: number;
}

export type Theme = "system" | "light" | "dark";
export type Category =
  | "All"
  | "Documents"
  | "Images"
  | "Music"
  | "Videos"
  | "Programs"
  | "Downloads";

interface SearchState {
  query: string;
  results: SearchResult[];
  filteredResults: SearchResult[];
  selectedId: number | null;
  isSearching: boolean;
  category: Category;
  sizeFilter: string;
  dateFilter: string;
  theme: Theme;
  customDirs: string[];
  excludedDirs: string[];
  indexingProgress: { phase: string; progress: number } | null;

  setQuery: (q: string) => void;
  setResults: (r: SearchResult[]) => void;
  setSelectedId: (id: number | null) => void;
  setIsSearching: (b: boolean) => void;
  setCategory: (c: Category) => void;
  setSizeFilter: (s: string) => void;
  setDateFilter: (d: string) => void;
  setTheme: (t: Theme) => void;
  setCustomDirs: (dirs: string[]) => void;
  setExcludedDirs: (dirs: string[]) => void;
  setIndexingProgress: (p: { phase: string; progress: number } | null) => void;
}

export const useSearchStore = create<SearchState>((set) => ({
  query: "",
  results: [],
  filteredResults: [],
  selectedId: null,
  isSearching: false,
  category: "All",
  sizeFilter: "Any Size",
  dateFilter: "Any Time",
  theme: "system",
  customDirs: [],
  excludedDirs: [],
  indexingProgress: null,

  setQuery: (query) => set({ query }),
  setResults: (results) =>
    set((state) => ({
      results,
      // Apply filters on set
      filteredResults: applyFilters(results, state.category),
    })),
  setSelectedId: (selectedId) => set({ selectedId }),
  setIsSearching: (isSearching) => set({ isSearching }),

  setCategory: (category) =>
    set((state) => ({
      category,
      filteredResults: applyFilters(state.results, category),
    })),
  setSizeFilter: (sizeFilter) =>
    set((state) => ({
      sizeFilter,
      filteredResults: applyFilters(state.results, state.category),
    })),
  setDateFilter: (dateFilter) =>
    set((state) => ({
      dateFilter,
      filteredResults: applyFilters(state.results, state.category),
    })),

  setTheme: (theme) => set({ theme }),
  setCustomDirs: (customDirs) => set({ customDirs }),
  setExcludedDirs: (excludedDirs) => set({ excludedDirs }),
  setIndexingProgress: (indexingProgress) => set({ indexingProgress }),
}));

function applyFilters(results: SearchResult[], category: string) {
  let res = results;

  // Category filter
  if (category !== "All") {
    res = res.filter((r) => {
      const ext = r.title.split(".").pop()?.toLowerCase();
      switch (category) {
        case "Documents":
          return [
            "txt",
            "md",
            "doc",
            "docx",
            "pdf",
            "csv",
            "rs",
            "ts",
            "tsx",
            "js",
            "json",
          ].includes(ext || "");
        case "Images":
          return ["jpg", "jpeg", "png", "gif", "svg", "webp"].includes(
            ext || "",
          );
        case "Music":
          return ["mp3", "wav", "flac", "ogg"].includes(ext || "");
        case "Videos":
          return ["mp4", "mkv", "avi", "mov"].includes(ext || "");
        case "Programs":
          return ["exe", "msi", "bat", "cmd"].includes(ext || "");
        case "Downloads":
          return r.path.toLowerCase().includes("downloads");
        default:
          return true;
      }
    });
  }

  // Size filter is hard to do without `fs.stat` on frontend, so we usually
  // rely on backend or just skip if we don't have file size in SearchResult yet.
  // For now, assume it's just a placeholder or we leave as is.

  return res;
}
