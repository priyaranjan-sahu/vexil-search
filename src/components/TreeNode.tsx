import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DirEntry } from "../store/searchStore";

interface TreeNodeProps {
  path: string;
  name: string;
  customDirs: string[];
  setCustomDirs: (dirs: string[]) => void;
  excludedDirs: string[];
  setExcludedDirs: (dirs: string[]) => void;
  isRoot?: boolean;
  parentIsChecked?: boolean;
}

export const TreeNode = ({
  path,
  name,
  customDirs,
  setCustomDirs,
  excludedDirs,
  setExcludedDirs,
  isRoot = false,
  parentIsChecked = false,
}: TreeNodeProps) => {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const isExplicitlyChecked = customDirs.includes(path);
  const isExplicitlyExcluded = excludedDirs.includes(path);
  const isEffectivelyChecked =
    (isExplicitlyChecked || parentIsChecked) && !isExplicitlyExcluded;

  const toggleExpand = async () => {
    if (!expanded && children.length === 0) {
      setLoading(true);
      try {
        const subdirs = await invoke<DirEntry[]>("get_directories", { path });
        setChildren(subdirs);
      } catch (e) {
        console.error(e);
      }
      setLoading(false);
    }
    setExpanded(!expanded);
  };

  const toggleCheck = () => {
    if (parentIsChecked) {
      if (isEffectivelyChecked) {
        // Exclude it
        setExcludedDirs([...excludedDirs, path]);
      } else {
        // Re-include it
        setExcludedDirs(excludedDirs.filter((p) => p !== path));
      }
    } else {
      if (isEffectivelyChecked) {
        // Uncheck it explicitly
        setCustomDirs(customDirs.filter((p) => p !== path));
      } else {
        // Check it explicitly
        setCustomDirs([...customDirs, path]);
        setExcludedDirs(excludedDirs.filter((p) => p !== path));
      }
    }
  };

  return (
    <div style={{ marginLeft: isRoot ? 0 : 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "4px 0",
        }}
      >
        <button
          onClick={toggleExpand}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            width: "20px",
            padding: 0,
            color: "var(--text-secondary)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {loading ? (
            <span style={{ fontSize: "0.75rem", lineHeight: 1 }}>...</span>
          ) : (
            <svg
              viewBox="0 0 12 8"
              width="12"
              height="8"
              style={{
                color: "var(--text-secondary)",
                transform: expanded ? "none" : "rotate(-90deg)",
              }}
            >
              <polygon points="0,0 12,0 6,8" fill="currentColor" />
            </svg>
          )}
        </button>
        <input
          type="checkbox"
          checked={isEffectivelyChecked}
          onChange={toggleCheck}
        />
        <span
          style={{
            fontSize: "0.9rem",
            cursor: "default",
            color: "var(--text-primary)",
          }}
          onDoubleClick={toggleExpand}
        >
          {name}
        </span>
      </div>
      {expanded && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.path}
              path={child.path}
              name={child.name}
              customDirs={customDirs}
              setCustomDirs={setCustomDirs}
              excludedDirs={excludedDirs}
              setExcludedDirs={setExcludedDirs}
              parentIsChecked={isEffectivelyChecked}
            />
          ))}
        </div>
      )}
    </div>
  );
};
