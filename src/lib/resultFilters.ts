import type { SearchResult } from "../store/searchStore";

export function applySizeFilter(result: SearchResult, filter: string): boolean {
  if (filter === "Any Size") return true;
  const sizeInMB = result.size / (1024 * 1024);
  switch (filter) {
    case "Small (< 1MB)":
      return sizeInMB < 1;
    case "Medium (1-100MB)":
      return sizeInMB >= 1 && sizeInMB <= 100;
    case "Large (> 100MB)":
      return sizeInMB > 100;
    default:
      return true;
  }
}

export function applyDateFilter(result: SearchResult, filter: string): boolean {
  if (filter === "Any Time") return true;
  const modified = new Date(result.modified * 1000);
  const now = new Date();
  switch (filter) {
    case "Today": {
      const todayStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
      );
      return modified >= todayStart;
    }
    case "This Week": {
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay());
      weekStart.setHours(0, 0, 0, 0);
      return modified >= weekStart;
    }
    case "This Month": {
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      return modified >= monthStart;
    }
    default:
      return true;
  }
}

export function getFilteredResults(
  results: SearchResult[],
  sizeFilter: string,
  dateFilter: string,
): SearchResult[] {
  return results.filter(
    (r) => applySizeFilter(r, sizeFilter) && applyDateFilter(r, dateFilter),
  );
}
