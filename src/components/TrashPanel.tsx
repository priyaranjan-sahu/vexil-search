import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TRASH_RETENTION_DAYS } from "../lib/confirmDelete";

export interface TrashItem {
  id: number;
  name: string;
  original_path: string;
  size_bytes: number;
  deleted_at: number;
  days_left: number;
}

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const TB = GB * 1024;

function formatSize(bytes: number): string {
  if (!bytes) return "0 B";
  // Written as thresholds rather than a units array lookup so there is no
  // dynamic index into a collection.
  const scale =
    bytes >= TB
      ? TB
      : bytes >= GB
        ? GB
        : bytes >= MB
          ? MB
          : bytes >= KB
            ? KB
            : 1;
  const unit =
    scale === TB
      ? "TB"
      : scale === GB
        ? "GB"
        : scale === MB
          ? "MB"
          : scale === KB
            ? "KB"
            : "B";
  const value = bytes / scale;
  // One decimal for 10.0-1023.9, none below 10 where "0.5 KB" is noise.
  return `${value >= 10 || scale === 1 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

interface Props {
  onClose: () => void;
  /** Called after a restore or an empty, so the caller can refresh its list. */
  onChanged?: () => void;
}

export function TrashPanel({ onClose, onChanged }: Props) {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Reload after an action. Set state after the await, never before it.
  const refresh = useCallback(async () => {
    try {
      const loaded = await invoke<TrashItem[]>("trash_items");
      setItems(loaded);
      setMessage(null);
    } catch (error) {
      setMessage(`Could not open Trash: ${error}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Intentionally not `void refresh()`: calling a state-setting function
    // straight from the effect body triggers a cascading render. The update
    // belongs in the promise callback, and `live` drops it if the panel closes
    // before the command returns.
    let live = true;
    invoke<TrashItem[]>("trash_items")
      .then((loaded) => {
        if (!live) return;
        setItems(loaded);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (!live) return;
        setMessage(`Could not open Trash: ${error}`);
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const restore = useCallback(
    async (item: TrashItem) => {
      setBusyId(item.id);
      try {
        const path = await invoke<string>("restore_trashed_file", {
          id: item.id,
        });
        setItems((prev) => prev.filter((i) => i.id !== item.id));
        setMessage(`Restored to ${path}`);
        onChanged?.();
      } catch (error) {
        setMessage(`Could not restore: ${error}`);
      } finally {
        setBusyId(null);
      }
    },
    [onChanged],
  );

  const empty = useCallback(async () => {
    if (
      !window.confirm(
        `Permanently delete all ${items.length} file${items.length === 1 ? "" : "s"} in Trash?\n\nThis cannot be undone.`,
      )
    ) {
      return;
    }
    setBusyId(-1);
    try {
      setMessage(await invoke<string>("empty_trash"));
      await refresh();
      onChanged?.();
    } catch (error) {
      setMessage(`Could not empty Trash: ${error}`);
    } finally {
      setBusyId(null);
    }
  }, [items.length, onChanged, refresh]);

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="settings-panel trash-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="trash-header">
          <h2 className="settings-header">Trash</h2>
          <button className="trash-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <p className="trash-hint">
          Files you delete land here and can be restored for{" "}
          {TRASH_RETENTION_DAYS} days. After that they are removed
          automatically.
        </p>

        {message && <div className="trash-message">{message}</div>}

        {loading ? (
          <div className="trash-empty">Loading…</div>
        ) : items.length === 0 ? (
          <div className="trash-empty">Trash is empty</div>
        ) : (
          <ul className="trash-list">
            {items.map((item) => (
              <li key={item.id} className="trash-item">
                <div className="trash-item-main">
                  <div className="trash-item-name">{item.name}</div>
                  <div className="trash-item-meta">
                    {formatSize(item.size_bytes)} ·{" "}
                    {item.days_left > 0
                      ? `${item.days_left} day${item.days_left === 1 ? "" : "s"} left`
                      : "removing soon"}
                  </div>
                  <div className="trash-item-path" title={item.original_path}>
                    {item.original_path}
                  </div>
                </div>
                <button
                  className="trash-restore-btn"
                  disabled={busyId !== null}
                  onClick={() => void restore(item)}
                >
                  {busyId === item.id ? "Restoring…" : "Restore"}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="trash-footer">
          <button
            className="trash-empty-btn"
            disabled={items.length === 0 || busyId !== null}
            onClick={() => void empty()}
          >
            {busyId === -1 ? "Emptying…" : "Empty Trash"}
          </button>
          <button className="trash-close-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
