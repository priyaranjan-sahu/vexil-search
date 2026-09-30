import { useEffect, useMemo, useRef } from "react";
import { useSearchStore } from "../../store/searchStore";
import type { SearchResult } from "../../store/searchStore";
import { getFilteredResults } from "../../lib/resultFilters";
import { ResultCard } from "../components/ResultCard";

const CATEGORIES = [
  "All",
  "Music",
  "Videos",
  "Programs",
  "Images",
  "Documents",
  "Archives",
  "Code",
  "Folder",
];

const SIZES = [
  "Any Size",
  "Small (< 1MB)",
  "Medium (1-100MB)",
  "Large (> 100MB)",
];
const DATES = ["Any Time", "Today", "This Week", "This Month"];

const ChipRow = ({
  items,
  active,
  onSelect,
}: {
  items: string[];
  active: string;
  onSelect: (value: string) => void;
}) => (
  <div className="mob-chiprow" role="group">
    {items.map((item) => (
      <button
        key={item}
        type="button"
        className={`mob-chip${item === active ? " active" : ""}`}
        onClick={() => onSelect(item)}
      >
        {item}
      </button>
    ))}
  </div>
);

export const SearchTab = ({
  onLongPress,
}: {
  onLongPress: (result: SearchResult) => void;
}) => {
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  const results = useSearchStore((s) => s.results);
  const isSearching = useSearchStore((s) => s.isSearching);
  const dbTotalCount = useSearchStore((s) => s.dbTotalCount);
  const activeCategory = useSearchStore((s) => s.activeCategory);
  const setActiveCategory = useSearchStore((s) => s.setActiveCategory);
  const activeSizeFilter = useSearchStore((s) => s.activeSizeFilter);
  const setActiveSizeFilter = useSearchStore((s) => s.setActiveSizeFilter);
  const activeDateFilter = useSearchStore((s) => s.activeDateFilter);
  const setActiveDateFilter = useSearchStore((s) => s.setActiveDateFilter);
  const myPicks = useSearchStore((s) => s.myPicks);
  const openResult = useSearchStore((s) => s.openResult);

  const filteredResults = useMemo(
    () => getFilteredResults(results, activeSizeFilter, activeDateFilter),
    [results, activeSizeFilter, activeDateFilter],
  );

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [activeCategory, activeSizeFilter, activeDateFilter]);

  return (
    <section className="mob-tab-content">
      <div className="mob-filters">
        <ChipRow
          items={CATEGORIES}
          active={activeCategory}
          onSelect={setActiveCategory}
        />
        <ChipRow
          items={SIZES}
          active={activeSizeFilter}
          onSelect={setActiveSizeFilter}
        />
        <ChipRow
          items={DATES}
          active={activeDateFilter}
          onSelect={setActiveDateFilter}
        />
      </div>

      <div className="mob-search" role="search">
        <svg
          className="mob-search-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input
          type="search"
          className="mob-search-input"
          placeholder="Search documents, apps, files..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          enterKeyHint="search"
          aria-label="Search"
        />
        {query && (
          <button
            type="button"
            className="mob-clear"
            onClick={() => setQuery("")}
            aria-label="Clear search"
          >
            ✕
          </button>
        )}
      </div>

      <div className="mob-info">
        {filteredResults.length} result{filteredResults.length === 1 ? "" : "s"}{" "}
        · DB: {dbTotalCount.toLocaleString()} files
      </div>

      <div className="mob-scroll" ref={scrollRef}>
        {isSearching ? (
          <div className="mob-loading">
            <span className="mob-spinner" aria-hidden="true" />
            <span>Searching local vectors...</span>
          </div>
        ) : filteredResults.length > 0 ? (
          <ul className="mob-list">
            {filteredResults.map((result) => (
              <ResultCard
                key={result.id}
                result={result}
                isPinned={myPicks.some((p) => p.id === result.id)}
                onOpen={() => void openResult(result)}
                onLongPress={onLongPress}
              />
            ))}
          </ul>
        ) : (
          <div className="mob-empty">
            {query.trim()
              ? "No results found"
              : "Start typing to search your files"}
          </div>
        )}
      </div>
    </section>
  );
};
