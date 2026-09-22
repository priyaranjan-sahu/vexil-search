import React from "react";
import { useSearchStore } from "../store";

export const Toolbar = () => {
  const query = useSearchStore((state) => state.query);
  const setQuery = useSearchStore((state) => state.setQuery);
  const isSearching = useSearchStore((state) => state.isSearching);

  return (
    <div className="search-wrapper">
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
        placeholder="Search files..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      {isSearching && <div className="search-spinner" />}
    </div>
  );
};
