import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { HighlightedSnippet } from "./HighlightedSnippet";
import {
  useSearchStore,
  SearchResult,
  BrowseSection,
} from "../store/searchStore";

const getCategoryIcon = (category: string) => {
  const defaultStyle = {
    marginRight: "8px",
    verticalAlign: "middle",
    width: "16px",
    height: "16px",
  };

  switch (category) {
    case "Music":
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          style={defaultStyle}
        >
          <path d="M9 18V5l12-2v13"></path>
          <circle cx="6" cy="18" r="3"></circle>
          <circle cx="18" cy="16" r="3"></circle>
        </svg>
      );
    case "Videos":
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          style={defaultStyle}
        >
          <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect>
          <line x1="7" y1="2" x2="7" y2="22"></line>
          <line x1="17" y1="2" x2="17" y2="22"></line>
          <line x1="2" y1="12" x2="22" y2="12"></line>
          <line x1="2" y1="7" x2="7" y2="7"></line>
          <line x1="2" y1="17" x2="7" y2="17"></line>
          <line x1="17" y1="17" x2="22" y2="17"></line>
          <line x1="17" y1="7" x2="22" y2="7"></line>
        </svg>
      );
    case "Images":
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          style={defaultStyle}
        >
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          <circle cx="8.5" cy="8.5" r="1.5"></circle>
          <polyline points="21 15 16 10 5 21"></polyline>
        </svg>
      );
    case "Documents":
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          style={defaultStyle}
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="16" y1="13" x2="8" y2="13"></line>
          <line x1="16" y1="17" x2="8" y2="17"></line>
          <polyline points="10 9 9 9 8 9"></polyline>
        </svg>
      );
    case "Programs":
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          style={defaultStyle}
        >
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
          <line x1="8" y1="21" x2="16" y2="21"></line>
          <line x1="12" y1="17" x2="12" y2="21"></line>
        </svg>
      );
    case "Archives":
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          style={defaultStyle}
        >
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
          <line x1="16" y1="2" x2="16" y2="4"></line>
          <line x1="8" y1="2" x2="8" y2="4"></line>
          <circle cx="12" cy="11" r="1"></circle>
          <path d="M12 12v6"></path>
        </svg>
      );
    case "Code":
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          style={defaultStyle}
        >
          <polyline points="16 18 22 12 16 6"></polyline>
          <polyline points="8 6 2 12 8 18"></polyline>
        </svg>
      );
    case "Folder":
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          style={defaultStyle}
        >
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
        </svg>
      );
    default:
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          style={defaultStyle}
        >
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
          <polyline points="13 2 13 9 20 9"></polyline>
        </svg>
      );
  }
};

export const ResultsTable = ({
  filteredResults,
  selectedResult,
  setSelectedResult,
  setContextMenu,
  browseSections = [],
  isBrowsing = false,
}: {
  filteredResults: SearchResult[];
  selectedResult: SearchResult | null;
  setSelectedResult: (res: SearchResult) => void;
  setContextMenu: (menu: {
    x: number;
    y: number;
    result: SearchResult;
  }) => void;
  browseSections?: BrowseSection[];
  isBrowsing?: boolean;
}) => {
  const isSearching = useSearchStore((state) => state.isSearching);

  const parentRef = useRef<HTMLDivElement>(null);

  // eslint-disable-next-line react-hooks/incompatible-library -- @tanstack/react-virtual is a third-party hooks library
  const virtualizer = useVirtualizer({
    count: filteredResults.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48, // rows are ~40px; slight over-estimate avoids scroll jitter
    overscan: 5,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const openResult = useSearchStore((state) => state.openResult);

  return (
    <div
      className="results-panel"
      style={{ borderRight: "1px solid var(--surface-border)" }}
    >
      <div
        className="results-container"
        ref={parentRef}
        style={{ overflow: "auto", height: "100%" }}
      >
        {isSearching ? (
          <div className="loading">
            <div className="spinner"></div>
            <span>Searching local vectors...</span>
          </div>
        ) : isBrowsing ? (
          browseSections.length > 0 ? (
            <div className="browse-view">
              {browseSections.map((section) => (
                <section key={section.category} className="browse-section">
                  <div className="browse-header">
                    <span className="browse-header-title">
                      {getCategoryIcon(section.category)}
                      {section.category}
                    </span>
                    <span className="browse-summary">
                      {section.count.toLocaleString()}{" "}
                      {section.count === 1 ? "file" : "files"}
                      {section.files.length < section.count &&
                        section.files.length > 0 &&
                        ` · showing the ${section.files.length} latest`}
                    </span>
                  </div>
                  {section.files.length > 0 ? (
                    <table className="data-table browse-table">
                      <tbody>
                        {section.files.map((result) => (
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
                              setContextMenu({
                                x: e.clientX,
                                y: e.clientY,
                                result,
                              });
                            }}
                          >
                            <td className="td-name">
                              {getCategoryIcon(result.category)}
                              {result.title}
                            </td>
                            <td title={result.path}>{result.path}</td>
                            <td>
                              <HighlightedSnippet
                                text={result.snippet || result.title}
                              />
                            </td>
                            <td className="td-relevance">—</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="browse-empty-row">
                      No files in this category yet.
                    </div>
                  )}
                </section>
              ))}
            </div>
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
              <p>No files indexed yet. Start typing to search...</p>
            </div>
          )
        ) : filteredResults.length > 0 ? (
          <div style={{ height: "100%", width: "100%" }}>
            <table className="data-table" style={{ width: "100%" }}>
              <thead>
                <tr
                  style={{
                    position: "sticky",
                    top: 0,
                    zIndex: 1,
                    backgroundColor: "var(--surface-color)",
                  }}
                >
                  <th>Name</th>
                  <th>Path</th>
                  <th>Snippet</th>
                  <th style={{ textAlign: "right" }}>Relevance</th>
                </tr>
              </thead>
              <tbody>
                {virtualItems.length > 0 && virtualItems[0].start > 0 && (
                  <tr>
                    <td
                      style={{
                        height: `${virtualItems[0].start}px`,
                        padding: 0,
                        border: 0,
                      }}
                      colSpan={4}
                    />
                  </tr>
                )}
                {virtualItems.map((virtualRow) => {
                  const result = filteredResults[virtualRow.index];
                  return (
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
                        {getCategoryIcon(result.category)}
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
                  );
                })}
                {virtualItems.length > 0 &&
                  virtualizer.getTotalSize() -
                    virtualItems[virtualItems.length - 1].end >
                    0 && (
                    <tr>
                      <td
                        style={{
                          height: `${virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end}px`,
                          padding: 0,
                          border: 0,
                        }}
                        colSpan={4}
                      />
                    </tr>
                  )}
              </tbody>
            </table>
          </div>
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
            <p>Start typing to search your files...</p>
          </div>
        )}
      </div>
    </div>
  );
};
