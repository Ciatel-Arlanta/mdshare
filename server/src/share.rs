//! The shared root: path resolution, file tree, and search.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

const MARKDOWN_EXTS: &[&str] = &["md", "markdown", "mdx", "mdown", "mkd", "mkdn"];
const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "bmp", "ico",
];
const OTHER_ASSET_EXTS: &[&str] = &["txt", "pdf"];
/// Directories that are never useful to read and can be huge.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".expo",
    ".gradle",
    ".idea",
    ".turbo",
    ".cache",
];
const MAX_DEPTH: usize = 16;
const MAX_ENTRIES: usize = 20_000;
const MAX_SEARCH_FILE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ShareKind {
    File,
    Folder,
}

#[derive(Debug)]
pub struct Share {
    /// Canonical directory everything is served from.
    pub root: PathBuf,
    pub kind: ShareKind,
    /// For a single-file share, the file name relative to `root`.
    pub entry: Option<String>,
    pub name: String,
}

#[derive(Serialize, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Node {
    Dir {
        name: String,
        path: String,
        children: Vec<Node>,
    },
    File {
        name: String,
        path: String,
        size: u64,
        mtime: u64,
        markdown: bool,
    },
}

#[derive(Serialize, Debug)]
pub struct SearchHit {
    pub path: String,
    pub line: usize,
    pub text: String,
}

pub fn is_markdown(path: &Path) -> bool {
    ext_in(path, MARKDOWN_EXTS)
}

pub fn is_listed(path: &Path) -> bool {
    ext_in(path, MARKDOWN_EXTS) || ext_in(path, IMAGE_EXTS) || ext_in(path, OTHER_ASSET_EXTS)
}

fn ext_in(path: &Path, list: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| list.iter().any(|x| x.eq_ignore_ascii_case(e)))
}

/// Whether a relative path passes through a directory the tree never shows.
pub fn in_skipped_dir(rel: &str) -> bool {
    rel.split('/')
        .any(|part| SKIP_DIRS.iter().any(|s| s.eq_ignore_ascii_case(part)))
}

pub fn mtime_secs(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs())
}

/// Forward-slash path of `full` relative to `root`.
pub fn rel_path(root: &Path, full: &Path) -> Option<String> {
    let rel = full.strip_prefix(root).ok()?;
    let parts: Vec<_> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .collect();
    Some(parts.join("/"))
}

impl Share {
    pub fn open(path: &Path, name: Option<String>) -> anyhow::Result<Self> {
        let full = fs::canonicalize(path)
            .map_err(|e| anyhow::anyhow!("cannot open {}: {e}", path.display()))?;
        let meta = fs::metadata(&full)?;
        let (root, kind, entry) = if meta.is_dir() {
            (full.clone(), ShareKind::Folder, None)
        } else {
            anyhow::ensure!(
                is_markdown(&full),
                "{} is not a markdown file",
                path.display()
            );
            let parent = full.parent().expect("file has a parent").to_path_buf();
            let file = full.file_name().unwrap().to_string_lossy().into_owned();
            (parent, ShareKind::File, Some(file))
        };
        let name = name.unwrap_or_else(|| {
            full.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| full.display().to_string())
        });
        Ok(Self {
            root,
            kind,
            entry,
            name,
        })
    }

    /// Resolves a client-supplied relative path to a file inside the share.
    /// Rejects traversal, absolute paths, symlinks escaping the root, and (for
    /// single-file shares) anything other than the shared file and assets.
    pub fn resolve(&self, rel: &str) -> Option<PathBuf> {
        let rel = rel.trim_start_matches('/');
        if rel.is_empty() || rel.contains('\0') || rel.contains('\\') {
            return None;
        }
        let candidate = Path::new(rel);
        if !candidate
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
        {
            return None;
        }
        let full = fs::canonicalize(self.root.join(candidate)).ok()?;
        if !full.starts_with(&self.root) || !full.is_file() {
            return None;
        }
        if !self.allows(&full) {
            return None;
        }
        Some(full)
    }

    /// Whether a canonical path inside the root is part of the share.
    pub fn allows(&self, full: &Path) -> bool {
        match (&self.kind, &self.entry) {
            (ShareKind::File, Some(entry)) => {
                // The shared file itself, plus images it may reference.
                // Sibling documents stay private.
                rel_path(&self.root, full).as_deref() == Some(entry.as_str())
                    || ext_in(full, IMAGE_EXTS)
            }
            // Only the kinds of files the tree lists; never `.env`, keys or code.
            _ => {
                is_listed(full) && !in_skipped_dir(&rel_path(&self.root, full).unwrap_or_default())
            }
        }
    }

    pub fn tree(&self) -> Node {
        if let (ShareKind::File, Some(entry)) = (self.kind, &self.entry) {
            let full = self.root.join(entry);
            let meta = fs::metadata(&full).ok();
            return Node::Dir {
                name: self.name.clone(),
                path: String::new(),
                children: vec![Node::File {
                    name: entry.clone(),
                    path: entry.clone(),
                    size: meta.as_ref().map_or(0, |m| m.len()),
                    mtime: meta.as_ref().map_or(0, mtime_secs),
                    markdown: true,
                }],
            };
        }
        let mut budget = MAX_ENTRIES;
        let children = walk_dir(&self.root, &self.root, 0, &mut budget);
        Node::Dir {
            name: self.name.clone(),
            path: String::new(),
            children,
        }
    }

    /// Every markdown file in the share, as (relative, absolute) paths.
    pub fn markdown_files(&self) -> Vec<(String, PathBuf)> {
        fn collect(node: &Node, root: &Path, out: &mut Vec<(String, PathBuf)>) {
            match node {
                Node::Dir { children, .. } => {
                    children.iter().for_each(|c| collect(c, root, out));
                }
                Node::File {
                    path,
                    markdown: true,
                    ..
                } => {
                    out.push((path.clone(), root.join(path)));
                }
                Node::File { .. } => {}
            }
        }
        let mut out = Vec::new();
        collect(&self.tree(), &self.root, &mut out);
        out
    }

    /// Case-insensitive substring search over markdown files.
    pub fn search(&self, query: &str, limit: usize) -> Vec<SearchHit> {
        let needle = query.to_lowercase();
        if needle.trim().is_empty() {
            return Vec::new();
        }
        let mut hits = Vec::new();
        for (rel, full) in self.markdown_files() {
            if fs::metadata(&full).map_or(true, |m| m.len() > MAX_SEARCH_FILE_BYTES) {
                continue;
            }
            let Ok(text) = fs::read_to_string(&full) else {
                continue;
            };
            if rel.to_lowercase().contains(&needle) {
                hits.push(SearchHit {
                    path: rel.clone(),
                    line: 0,
                    text: String::new(),
                });
            }
            for (i, line) in text.lines().enumerate() {
                if line.to_lowercase().contains(&needle) {
                    hits.push(SearchHit {
                        path: rel.clone(),
                        line: i + 1,
                        text: snippet(line, &needle),
                    });
                    if hits.len() >= limit {
                        return hits;
                    }
                }
            }
        }
        hits
    }
}

/// Up to ~160 chars of `line` centred on the first match.
fn snippet(line: &str, needle: &str) -> String {
    let line = line.trim();
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= 160 {
        return line.to_string();
    }
    let lower: Vec<char> = line.to_lowercase().chars().collect();
    let needle: Vec<char> = needle.chars().collect();
    let at = lower
        .windows(needle.len().max(1))
        .position(|w| w == needle.as_slice())
        .unwrap_or(0)
        .min(chars.len());
    let start = at.saturating_sub(60);
    let end = (start + 160).min(chars.len());
    let mut s: String = chars[start..end].iter().collect();
    if start > 0 {
        s.insert(0, '…');
    }
    if end < chars.len() {
        s.push('…');
    }
    s
}

fn walk_dir(root: &Path, dir: &Path, depth: usize, budget: &mut usize) -> Vec<Node> {
    if depth > MAX_DEPTH {
        return Vec::new();
    }
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut entries: Vec<_> = read.filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());

    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in entries {
        if *budget == 0 {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(ft) = entry.file_type() else { continue };
        // Never follow symlinks while walking; they could leave the root.
        if ft.is_symlink() {
            continue;
        }
        let path = entry.path();
        if ft.is_dir() {
            if SKIP_DIRS.iter().any(|s| s.eq_ignore_ascii_case(&name)) {
                continue;
            }
            let children = walk_dir(root, &path, depth + 1, budget);
            if !children.is_empty() {
                let Some(rel) = rel_path(root, &path) else {
                    continue;
                };
                dirs.push(Node::Dir {
                    name,
                    path: rel,
                    children,
                });
            }
        } else if ft.is_file() && is_listed(&path) {
            let Some(rel) = rel_path(root, &path) else {
                continue;
            };
            let meta = entry.metadata().ok();
            *budget -= 1;
            files.push(Node::File {
                name,
                path: rel,
                size: meta.as_ref().map_or(0, |m| m.len()),
                mtime: meta.as_ref().map_or(0, mtime_secs),
                markdown: is_markdown(&path),
            });
        }
    }
    dirs.extend(files);
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, Share) {
        let dir = std::env::temp_dir().join(format!("mdshare-test-{}", rand::random::<u32>()));
        fs::create_dir_all(dir.join("docs/sub")).unwrap();
        fs::create_dir_all(dir.join("node_modules/x")).unwrap();
        fs::write(dir.join("README.md"), "# Hello\nSome Text here").unwrap();
        fs::write(dir.join("docs/plan.md"), "plan\nfind the NEEDLE").unwrap();
        fs::write(dir.join("docs/img.png"), [0u8; 4]).unwrap();
        fs::write(dir.join("docs/code.rs"), "fn main() {}").unwrap();
        fs::write(dir.join("node_modules/x/README.md"), "skip").unwrap();
        let share = Share::open(&dir, None).unwrap();
        (dir, share)
    }

    #[test]
    fn resolve_blocks_traversal() {
        let (dir, share) = fixture();
        assert!(share.resolve("README.md").is_some());
        assert!(share.resolve("docs/plan.md").is_some());
        assert!(share.resolve("../etc/passwd").is_none());
        assert!(share.resolve("docs/../../x").is_none());
        assert!(share.resolve("docs\\plan.md").is_none());
        assert!(share.resolve("/").is_none());
        assert!(share.resolve("docs").is_none());
        assert!(share.resolve("docs/code.rs").is_none());
        assert!(share.resolve("node_modules/x/README.md").is_none());
        assert!(
            share
                .resolve(&dir.join("README.md").to_string_lossy())
                .is_none()
        );
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn tree_lists_markdown_and_assets_only() {
        let (dir, share) = fixture();
        let files: Vec<_> = share.markdown_files().into_iter().map(|(r, _)| r).collect();
        assert_eq!(files, vec!["docs/plan.md", "README.md"]);
        let json = serde_json::to_string(&share.tree()).unwrap();
        assert!(json.contains("docs/img.png"));
        assert!(!json.contains("code.rs"));
        assert!(!json.contains("node_modules"));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn single_file_share_hides_siblings() {
        let (dir, _) = fixture();
        let share = Share::open(&dir.join("docs/plan.md"), None).unwrap();
        assert_eq!(share.kind, ShareKind::File);
        assert!(share.resolve("plan.md").is_some());
        assert!(share.resolve("img.png").is_some());
        assert!(share.resolve("code.rs").is_none());
        assert!(share.resolve("../README.md").is_none());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn search_is_case_insensitive() {
        let (dir, share) = fixture();
        let hits = share.search("needle", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "docs/plan.md");
        assert_eq!(hits[0].line, 2);
        fs::remove_dir_all(dir).ok();
    }
}
