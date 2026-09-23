import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { HighlightedSnippet } from "./HighlightedSnippet";
import { useSearchStore, SearchResult } from "../store/searchStore";

export const ResultsTable = ({
  filteredResults,
  selectedResult,
  setSelectedResult,
  setContextMenu,
}: {
  filteredResults: SearchResult[];
  selectedResult: SearchResult | null;
  setSelectedResult: (res: SearchResult) => void;
  setContextMenu: (menu: {
    x: number;
    y: number;
    result: SearchResult;
  }) => void;
}) => {
  const isSearching = useSearchStore((state) => state.isSearching);

  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: filteredResults.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40, // 40px row height
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
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          style={{
                            marginRight: "8px",
                            verticalAlign: "middle",
                            width: "16px",
                            height: "16px",
                          }}
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
