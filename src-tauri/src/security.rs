use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct AllowedRoots {}

impl AllowedRoots {
    pub fn new() -> Self {
        Self {}
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
        if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(SecurityError::PathTraversal);
        }
        
        // 2. We allow absolute paths (since it's a desktop app browsing local disks)
        // But if it's relative, we reject it because we don't have a secure base context.
        let abs = if path.is_absolute() {
            path
        } else {
            return Err(SecurityError::RelativePathNotAllowed);
        };
        
        // 3. Canonicalize (resolves symlinks, validates existence)
        let canon = abs.canonicalize()
            .map_err(|_| SecurityError::InvalidPath)?;
        
        Ok(canon)
    }
}

#[derive(Debug)]
pub enum SecurityError {
    PathTraversal,
    RelativePathNotAllowed,
    InvalidPath,
}

impl std::fmt::Display for SecurityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SecurityError::PathTraversal => write!(f, "Path traversal attempt detected"),
            SecurityError::RelativePathNotAllowed => write!(f, "Relative paths not allowed without base"),
            SecurityError::InvalidPath => write!(f, "Invalid or non-existent path"),
        }
    }
}

impl std::error::Error for SecurityError {}
