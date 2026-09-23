use std::path::{Component, PathBuf};

#[derive(Debug, Clone)]
pub struct AllowedRoots {
    roots: Vec<PathBuf>,
    allow_whole_disk: bool,
}

impl AllowedRoots {
    pub fn new(allow_whole_disk: bool) -> Self {
        let mut roots = Vec::new();
        if let Some(docs) = dirs::document_dir() {
            roots.push(docs);
        }
        if let Some(dl) = dirs::download_dir() {
            roots.push(dl);
        }
        Self {
            roots,
            allow_whole_disk,
        }
    }

    #[allow(dead_code)]
    pub fn add_custom(&mut self, path: PathBuf) {
        if let Ok(canon) = path.canonicalize() {
            self.roots.push(canon);
        }
    }

    // In our implementation, since the settings are passed dynamically to `start_indexing`,
    // it's slightly trickier to mutate this global state. For now, since `get_directories`
    // can technically browse anywhere on the system (e.g. from Root Drives), we need to
    // allow the user to browse their own filesystem but prevent them from traversing
    // OUTSIDE of a known base if they provided a relative path.
    // However, Vexil is a local desktop app designed to search the *whole* disk if they want.
    // So the primary danger is Path Traversal (e.g. going up from an allowed base).
    pub fn validate(&self, user_path: &str) -> Result<PathBuf, SecurityError> {
        let path = PathBuf::from(user_path);

        // 1. No traversal using component `..`
        if path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(SecurityError::PathTraversal);
        }

        // 2. We allow absolute paths
        // But if it's relative, we reject it because we don't have a secure base context.
        let abs = if path.is_absolute() {
            path
        } else {
            return Err(SecurityError::RelativePathNotAllowed);
        };

        // 3. Canonicalize (resolves symlinks, validates existence)
        let mut canon = abs.canonicalize().map_err(|_| SecurityError::InvalidPath)?;
        
        // Strip Windows UNC prefix if present
        if cfg!(windows) {
            let canon_str = canon.to_string_lossy().to_string();
            if canon_str.starts_with(r"\\?\") {
                canon = PathBuf::from(&canon_str[4..]);
            }
        }

        // 4. Enforce allow-list unless whole-disk mode
        if !self.allow_whole_disk {
            if !self.roots.iter().any(|r| canon.starts_with(r)) {
                return Err(SecurityError::OutsideAllowedRoots);
            }
        }

        Ok(canon)
    }
}

#[derive(Debug)]
pub enum SecurityError {
    PathTraversal,
    RelativePathNotAllowed,
    InvalidPath,
    OutsideAllowedRoots,
}

impl std::fmt::Display for SecurityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SecurityError::PathTraversal => write!(f, "Path traversal attempt detected"),
            SecurityError::RelativePathNotAllowed => {
                write!(f, "Relative paths not allowed without base")
            }
            SecurityError::InvalidPath => write!(f, "Invalid or non-existent path"),
            SecurityError::OutsideAllowedRoots => write!(f, "Path outside allowed directories"),
        }
    }
}

impl std::error::Error for SecurityError {}
