import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface DuplicateFile {
  id: number;
  path: string;
  title: string;
  size: number;
  modified: number;
  category: string;
}

export interface DuplicateGroup {
  hash: string;
  size: number;
  wasted_bytes: number;
  files: DuplicateFile[];
}

interface DuplicateFinderModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
  onDelete: (path: string) => Promise<void>;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  // eslint-disable-next-line security/detect-object-injection
  const unit = sizes[Math.min(i, sizes.length - 1)] ?? "B";
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${unit}`;
}

export const DuplicateFinderModal = ({
  isOpen,
  onClose,
  onOpen,
  onReveal,
  onDelete,
}: DuplicateFinderModalProps) => {
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;

    invoke<DuplicateGroup[]>("find_duplicates")
      .then((data) => {
        if (isMounted) {
          setGroups(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (isMounted) {
          setError(typeof err === "string" ? err : "Failed to find duplicates");
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
      setGroups([]);
      setSelectedPaths(new Set());
      setError(null);
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const totalWasted = groups.reduce((acc, g) => acc + g.wasted_bytes, 0);

  const toggleSelectPath = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const selectAllExceptNewest = () => {
    const toSelect = new Set<string>();
    for (const group of groups) {
      if (group.files.length < 2) continue;
      // Sort files by modified descending: newest is at index 0
      const sorted = [...group.files].sort((a, b) => b.modified - a.modified);
      // Select all except the newest one
      for (let i = 1; i < sorted.length; i++) {
        // eslint-disable-next-line security/detect-object-injection
        const file = sorted[i];
        if (file) toSelect.add(file.path);
      }
    }
    setSelectedPaths(toSelect);
  };

  const handleDeleteSelected = async () => {
    if (selectedPaths.size === 0) return;
    const count = selectedPaths.size;
    const confirm = window.confirm(
      `Are you sure you want to move ${count} duplicate file(s) to Trash?`,
    );
    if (!confirm) return;

    setDeleting(true);
    try {
      for (const path of selectedPaths) {
        await onDelete(path);
      }
      // Re-scan
      const refreshed = await invoke<DuplicateGroup[]>("find_duplicates");
      setGroups(refreshed);
      setSelectedPaths(new Set());
    } catch (err) {
      console.error("Failed to delete duplicates:", err);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0, 0, 0, 0.65)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10000,
        padding: "20px",
      }}
      onClick={onClose}
    >
      <div
        className="modal-container"
        style={{
          width: "820px",
          maxWidth: "92vw",
          maxHeight: "85vh",
          backgroundColor: "var(--surface-color)",
          borderRadius: "12px",
          border: "1px solid var(--surface-border)",
          boxShadow: "0 20px 40px rgba(0, 0, 0, 0.4)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--surface-border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            backgroundColor: "var(--bg-secondary)",
          }}
        >
          <div>
            <h2
              style={{
                margin: 0,
                fontSize: "1.2rem",
                fontWeight: 600,
                color: "var(--text-primary)",
              }}
            >
              Duplicate File Finder
            </h2>
            <div
              style={{
                fontSize: "0.8rem",
                color: "var(--text-secondary)",
                marginTop: "2px",
              }}
            >
              {loading
                ? "Analyzing indexed files for identical content..."
                : `${groups.length} duplicate group(s) found · ${formatBytes(totalWasted)} reclaimable space`}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-secondary)",
              fontSize: "1.4rem",
              cursor: "pointer",
              lineHeight: 1,
              padding: "4px",
            }}
            title="Close"
          >
            ✕
          </button>
        </div>

        {/* Content list */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "16px 20px",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
          }}
        >
          {loading && (
            <div
              style={{
                textAlign: "center",
                padding: "40px",
                color: "var(--text-secondary)",
              }}
            >
              Scanning files and verifying hashes...
            </div>
          )}

          {error && (
            <div
              style={{
                padding: "12px 16px",
                borderRadius: "6px",
                backgroundColor: "rgba(239, 68, 68, 0.1)",
                color: "#ef4444",
                fontSize: "0.85rem",
              }}
            >
              {error}
            </div>
          )}

          {!loading && !error && groups.length === 0 && (
            <div
              style={{
                textAlign: "center",
                padding: "60px 20px",
                color: "var(--text-secondary)",
              }}
            >
              <div style={{ fontSize: "2rem", marginBottom: "8px" }}>✨</div>
              <div
                style={{
                  fontWeight: 600,
                  fontSize: "1rem",
                  color: "var(--text-primary)",
                }}
              >
                No Duplicate Files Found
              </div>
              <div style={{ fontSize: "0.85rem", marginTop: "4px" }}>
                All indexed files across your libraries have unique content.
              </div>
            </div>
          )}

          {!loading &&
            groups.map((group) => (
              <div
                key={group.hash}
                style={{
                  border: "1px solid var(--surface-border)",
                  borderRadius: "8px",
                  overflow: "hidden",
                  backgroundColor: "var(--surface-color)",
                }}
              >
                <div
                  style={{
                    padding: "8px 14px",
                    backgroundColor: "var(--bg-secondary)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    fontSize: "0.8rem",
                    borderBottom: "1px solid var(--surface-border)",
                  }}
                >
                  <div style={{ display: "flex", gap: "10px" }}>
                    <span
                      style={{
                        fontWeight: 600,
                        color: "var(--text-primary)",
                      }}
                    >
                      {formatBytes(group.size)} each
                    </span>
                    <span style={{ color: "var(--text-secondary)" }}>
                      · {group.files.length} copies
                    </span>
                  </div>
                  <span
                    style={{
                      color: "var(--accent-color, #3b82f6)",
                      fontWeight: 500,
                    }}
                  >
                    Wastes {formatBytes(group.wasted_bytes)}
                  </span>
                </div>

                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  {group.files.map((file) => {
                    const isSelected = selectedPaths.has(file.path);
                    return (
                      <div
                        key={file.id}
                        style={{
                          padding: "8px 14px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          borderBottom: "1px solid var(--surface-border)",
                          backgroundColor: isSelected
                            ? "rgba(239, 68, 68, 0.08)"
                            : "transparent",
                          fontSize: "0.8rem",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "10px",
                            flex: 1,
                            minWidth: 0,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelectPath(file.path)}
                            title="Select for deletion"
                          />
                          <div
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              minWidth: 0,
                            }}
                          >
                            <span
                              style={{
                                fontWeight: 500,
                                color: "var(--text-primary)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {file.title}
                            </span>
                            <span
                              style={{
                                color: "var(--text-secondary)",
                                fontSize: "0.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={file.path}
                            >
                              {file.path}
                            </span>
                          </div>
                        </div>

                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            marginLeft: "12px",
                          }}
                        >
                          <button
                            onClick={() => onOpen(file.path)}
                            style={{
                              padding: "3px 8px",
                              fontSize: "0.75rem",
                              borderRadius: "4px",
                              border: "1px solid var(--surface-border)",
                              backgroundColor: "transparent",
                              color: "var(--text-primary)",
                              cursor: "pointer",
                            }}
                          >
                            Open
                          </button>
                          <button
                            onClick={() => onReveal(file.path)}
                            style={{
                              padding: "3px 8px",
                              fontSize: "0.75rem",
                              borderRadius: "4px",
                              border: "1px solid var(--surface-border)",
                              backgroundColor: "transparent",
                              color: "var(--text-secondary)",
                              cursor: "pointer",
                            }}
                          >
                            Reveal
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
        </div>

        {/* Footer actions */}
        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid var(--surface-border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            backgroundColor: "var(--bg-secondary)",
          }}
        >
          <button
            onClick={selectAllExceptNewest}
            disabled={groups.length === 0 || loading}
            style={{
              padding: "6px 12px",
              fontSize: "0.8rem",
              borderRadius: "6px",
              border: "1px solid var(--surface-border)",
              backgroundColor: "transparent",
              color: "var(--text-primary)",
              cursor:
                groups.length === 0 || loading ? "not-allowed" : "pointer",
            }}
          >
            Select All Except Newest
          </button>

          <div style={{ display: "flex", gap: "8px" }}>
            <button
              onClick={onClose}
              style={{
                padding: "6px 14px",
                fontSize: "0.8rem",
                borderRadius: "6px",
                border: "1px solid var(--surface-border)",
                backgroundColor: "transparent",
                color: "var(--text-primary)",
                cursor: "pointer",
              }}
            >
              Close
            </button>
            <button
              onClick={handleDeleteSelected}
              disabled={selectedPaths.size === 0 || deleting}
              style={{
                padding: "6px 16px",
                fontSize: "0.8rem",
                borderRadius: "6px",
                border: "none",
                backgroundColor: "#ef4444",
                color: "#ffffff",
                fontWeight: 500,
                cursor:
                  selectedPaths.size === 0 || deleting
                    ? "not-allowed"
                    : "pointer",
                opacity: selectedPaths.size === 0 || deleting ? 0.6 : 1,
              }}
            >
              {deleting
                ? "Deleting..."
                : `Delete Selected (${selectedPaths.size})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
