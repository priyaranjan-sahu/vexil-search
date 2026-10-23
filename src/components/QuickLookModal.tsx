import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SearchResult } from "../store/searchStore";

export interface FilePreview {
  path: string;
  title: string;
  size: number;
  modified: number;
  is_text: boolean;
  content: string;
  lines_count: number;
  extension: string;
}

interface QuickLookModalProps {
  result: SearchResult | null;
  onClose: () => void;
  onOpen: (result: SearchResult) => void;
  onReveal: (path: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const unit = sizes.at(Math.min(i, sizes.length - 1)) ?? "B";
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${unit}`;
}

export const QuickLookModal = ({
  result,
  onClose,
  onOpen,
  onReveal,
}: QuickLookModalProps) => {
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [copied, setCopied] = useState(false);

  const loading = Boolean(result && loadedPath !== result.path);

  useEffect(() => {
    if (!result?.path) return;

    let isMounted = true;

    invoke<FilePreview>("get_file_preview", { path: result.path })
      .then((data) => {
        if (isMounted) {
          setPreview(data);
          setLoadedPath(result.path);
        }
      })
      .catch((err) => {
        if (isMounted) {
          console.error("Failed to load file preview:", err);
          setLoadedPath(result.path);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [result?.path]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === " ") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (!result) return null;

  const handleCopyPath = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(result.path).catch(console.error);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const modifiedDate = result.modified
    ? new Date(result.modified * 1000).toLocaleString()
    : "Unknown";

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
        className="quick-look-dialog"
        style={{
          backgroundColor: "var(--surface-color)",
          border: "1px solid var(--surface-border)",
          borderRadius: "10px",
          width: "100%",
          maxWidth: "760px",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 20px 40px rgba(0,0,0,0.4)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 18px",
            borderBottom: "1px solid var(--surface-border)",
            backgroundColor: "var(--toolbar-bg)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              overflow: "hidden",
            }}
          >
            <span
              style={{
                fontSize: "0.75rem",
                textTransform: "uppercase",
                padding: "2px 8px",
                borderRadius: "4px",
                backgroundColor: "var(--brand-primary)",
                color: "#ffffff",
                fontWeight: 600,
              }}
            >
              {result.category}
            </span>
            <h2
              style={{
                margin: 0,
                fontSize: "1.05rem",
                fontWeight: 600,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                color: "var(--text-primary)",
              }}
              title={result.title}
            >
              {result.title}
            </h2>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--text-secondary)",
              fontSize: "1.2rem",
              padding: "4px 8px",
              borderRadius: "4px",
            }}
            title="Close (Esc or Space)"
          >
            ✕
          </button>
        </div>

        {/* Metadata Bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "16px",
            padding: "8px 18px",
            backgroundColor: "var(--input-bg)",
            fontSize: "0.8rem",
            color: "var(--text-secondary)",
            borderBottom: "1px solid var(--surface-border)",
          }}
        >
          <span>Size: {formatBytes(result.size)}</span>
          <span>·</span>
          <span>Modified: {modifiedDate}</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: "8px" }}>
            <button
              onClick={handleCopyPath}
              className="tool-btn"
              style={{ fontSize: "0.75rem", padding: "2px 8px" }}
              title="Copy path to clipboard"
            >
              {copied ? "Copied!" : "Copy Path"}
            </button>
          </span>
        </div>

        {/* Content Viewer */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "16px",
            backgroundColor: "var(--surface-color)",
          }}
        >
          {loading ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "40px",
                color: "var(--text-muted)",
              }}
            >
              <div
                className="spinner"
                style={{ width: "24px", height: "24px", marginBottom: "12px" }}
              />
              <span>Loading preview...</span>
            </div>
          ) : preview?.is_text && preview.content ? (
            <div style={{ position: "relative" }}>
              <pre
                style={{
                  margin: 0,
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  fontSize: "0.85rem",
                  lineHeight: "1.5",
                  color: "var(--text-primary)",
                  backgroundColor: "var(--input-bg)",
                  padding: "14px",
                  borderRadius: "6px",
                  border: "1px solid var(--surface-border)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  maxHeight: "450px",
                  overflowY: "auto",
                }}
              >
                {preview.content}
              </pre>
            </div>
          ) : result.snippet ? (
            <div
              style={{
                padding: "16px",
                backgroundColor: "var(--input-bg)",
                borderRadius: "6px",
                border: "1px solid var(--surface-border)",
              }}
            >
              <div
                style={{
                  fontSize: "0.8rem",
                  fontWeight: 600,
                  color: "var(--text-secondary)",
                  marginBottom: "8px",
                }}
              >
                Matched Content Snippet:
              </div>
              <div
                style={{
                  fontSize: "0.9rem",
                  lineHeight: "1.5",
                  color: "var(--text-primary)",
                }}
                dangerouslySetInnerHTML={{ __html: result.snippet }}
              />
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "40px",
                color: "var(--text-muted)",
                textAlign: "center",
              }}
            >
              <svg
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                style={{ marginBottom: "12px", opacity: 0.6 }}
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
              </svg>
              <p style={{ margin: 0, fontSize: "0.9rem" }}>
                Preview not available for this binary format.
              </p>
              <p
                style={{
                  margin: "6px 0 0 0",
                  fontSize: "0.8rem",
                  color: "var(--text-secondary)",
                }}
              >
                Use &ldquo;Open File&rdquo; to launch with the system default
                application.
              </p>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 18px",
            borderTop: "1px solid var(--surface-border)",
            backgroundColor: "var(--toolbar-bg)",
          }}
        >
          <div
            style={{
              fontSize: "0.8rem",
              color: "var(--text-muted)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: "350px",
            }}
            title={result.path}
          >
            {result.path}
          </div>
          <div style={{ display: "flex", gap: "10px" }}>
            <button
              className="tool-btn"
              onClick={() => onReveal(result.path)}
              style={{ padding: "6px 14px" }}
            >
              Reveal in Folder
            </button>
            <button
              className="tool-btn"
              style={{
                backgroundColor: "var(--brand-primary)",
                color: "#ffffff",
                border: "none",
                padding: "6px 16px",
                fontWeight: 600,
              }}
              onClick={() => onOpen(result)}
            >
              Open File
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
