import { useRef } from "react";
import type { SearchResult } from "../../store/searchStore";

const formatSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024 * 1024)
    return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
};

const formatDate = (secs: number): string => {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;

/** Tap-to-open row with long-press (≥500ms) action-sheet trigger. */
export const ResultCard = ({
  result,
  isPinned,
  onOpen,
  onLongPress,
}: {
  result: SearchResult;
  isPinned: boolean;
  onOpen: () => void;
  onLongPress: (result: SearchResult) => void;
}) => {
  const timerRef = useRef<number | undefined>(undefined);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const longPressedRef = useRef(false);

  const cancel = () => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    longPressedRef.current = false;
    startRef.current = { x: e.clientX, y: e.clientY };
    cancel();
    timerRef.current = window.setTimeout(() => {
      longPressedRef.current = true;
      onLongPress(result);
    }, LONG_PRESS_MS);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!startRef.current) return;
    const dx = e.clientX - startRef.current.x;
    const dy = e.clientY - startRef.current.y;
    if (Math.hypot(dx, dy) > MOVE_TOLERANCE_PX) cancel();
  };

  const handlePointerUp = cancel;

  return (
    <li
      className="mob-result"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={cancel}
      onClick={() => {
        if (longPressedRef.current) return;
        onOpen();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onLongPress(result);
      }}
    >
      <div className="mob-result-name">
        {isPinned && (
          <span className="mob-pin" aria-label="Pinned">
            ★
          </span>
        )}
        {result.title}
      </div>
      <div className="mob-result-path">{result.path}</div>
      <div className="mob-result-meta">
        <span className="mob-category">{result.category}</span>
        <span className="mob-meta">· {formatSize(result.size)}</span>
        {result.modified > 0 && (
          <span className="mob-meta">· {formatDate(result.modified)}</span>
        )}
        <span className="mob-relevance">{result.relevance}%</span>
      </div>
    </li>
  );
};
