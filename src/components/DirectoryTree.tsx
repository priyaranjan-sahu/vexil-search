import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TreeNode } from "./TreeNode";
import { useSearchStore } from "../store/searchStore";
import { useLicenseStore } from "../store/licenseStore";
export interface DriveInfo {
  path: string;
  name: string;
  is_pro_only: boolean;
}

export const DirectoryTree = () => {
  const customDirs = useSearchStore((state) => state.customDirs);
  const setCustomDirs = useSearchStore((state) => state.setCustomDirs);
  const excludedDirs = useSearchStore((state) => state.excludedDirs);
  const setExcludedDirs = useSearchStore((state) => state.setExcludedDirs);
  const pro = useLicenseStore((state) => state.status?.pro ?? false);

  const [drives, setDrives] = useState<DriveInfo[]>([]);

  useEffect(() => {
    invoke<DriveInfo[]>("get_system_drives")
      .then(setDrives)
      .catch(console.error);
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
          key={drive.path}
          path={drive.path}
          name={drive.name}
          customDirs={customDirs}
          setCustomDirs={setCustomDirs}
          excludedDirs={excludedDirs}
          setExcludedDirs={setExcludedDirs}
          isRoot={true}
          isProOnly={drive.is_pro_only}
          userIsPro={pro}
        />
      ))}
    </div>
  );
};
