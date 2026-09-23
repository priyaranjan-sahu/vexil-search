import { useSearchStore } from "../store/searchStore";

export const Toolbar = () => {
  const query = useSearchStore((state) => state.query);
  const setQuery = useSearchStore((state) => state.setQuery);
  const activeCategory = useSearchStore((state) => state.activeCategory);
  const setActiveCategory = useSearchStore((state) => state.setActiveCategory);
  const activeSizeFilter = useSearchStore((state) => state.activeSizeFilter);
  const setActiveSizeFilter = useSearchStore(
    (state) => state.setActiveSizeFilter,
  );
  const activeDateFilter = useSearchStore((state) => state.activeDateFilter);
  const setActiveDateFilter = useSearchStore(
    (state) => state.setActiveDateFilter,
  );
  const selectedResult = useSearchStore((state) => state.selectedResult);
  const openResult = useSearchStore((state) => state.openResult);
  const handleCopyPath = useSearchStore((state) => state.handleCopyPath);
  const handleDelete = useSearchStore((state) => state.handleDelete);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    // Search is debounced via useEffect in App
  };

  const sizeOptions = [
    { value: "Any Size", label: "Any Size" },
    { value: "Small (< 1MB)", label: "Small (< 1MB)" },
    { value: "Medium (1-100MB)", label: "Medium (1-100MB)" },
    { value: "Large (> 100MB)", label: "Large (> 100MB)" },
  ];

  const dateOptions = [
    { value: "Any Time", label: "Any Time" },
    { value: "Today", label: "Today" },
    { value: "This Week", label: "This Week" },
    { value: "This Month", label: "This Month" },
  ];

  return (
    <div className="toolbar">
      <form className="search-wrapper" onSubmit={handleSearch}>
        <svg
          className="search-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          className="search-input"
          placeholder="Search documents, apps, files..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
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
            {sizeOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <select
            className="advanced-filter-select"
            value={activeDateFilter}
            onChange={(e) => setActiveDateFilter(e.target.value)}
          >
            {dateOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="toolbar-divider" style={{ marginLeft: "auto" }}></div>

        <div className="toolbar-group">
          <button
            className="tool-btn"
            disabled={!selectedResult}
            onClick={() => selectedResult && openResult(selectedResult)}
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
  );
};
