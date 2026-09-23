import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TreeNode } from "./TreeNode";
import { useSearchStore } from "../store/searchStore";

export const DirectoryTree = () => {
  const customDirs = useSearchStore((state) => state.customDirs);
  const setCustomDirs = useSearchStore((state) => state.setCustomDirs);
  const excludedDirs = useSearchStore((state) => state.excludedDirs);
  const setExcludedDirs = useSearchStore((state) => state.setExcludedDirs);

  const [drives, setDrives] = useState<string[]>([]);

  useEffect(() => {
    invoke<string[]>("get_system_drives").then(setDrives).catch(console.error);
  }, []);

  return (
    <div
      style={{
        maxHeight: "300px",
        overflowY: "auto",
        background: "var(--surface-color)",
        border: "1px solid var(--surface-border)",
        borderRadius: "6px",
        padding: "8px",
        textAlign: "left",
      }}
    >
      {drives.length === 0 && (
        <div style={{ color: "var(--text-muted)" }}>Loading drives...</div>
      )}
      {drives.map((drive) => (
        <TreeNode
          key={drive}
          path={drive}
          name={drive}
          customDirs={customDirs}
          setCustomDirs={setCustomDirs}
          excludedDirs={excludedDirs}
          setExcludedDirs={setExcludedDirs}
          isRoot={true}
        />
      ))}
    </div>
  );
};
