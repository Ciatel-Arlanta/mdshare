//! File watching for live reload.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use notify::{EventKind, RecursiveMode, Watcher};
use tokio::sync::{broadcast, mpsc};

use crate::server::ChangeEvent;
use crate::share::{Share, ShareKind, in_skipped_dir, is_listed, rel_path};

/// Bursts of filesystem events (editors and agents often write a file in
/// several steps) are merged over this window into one change event.
const DEBOUNCE: Duration = Duration::from_millis(200);

/// Starts watching the share. The returned watcher must be kept alive.
pub fn spawn(
    share: Arc<crate::server::AppState>,
    events: broadcast::Sender<ChangeEvent>,
) -> anyhow::Result<notify::RecommendedWatcher> {
    let (tx, mut rx) = mpsc::unbounded_channel::<notify::Event>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            let _ = tx.send(event);
        }
    })?;
    let mode = match share.share.kind {
        ShareKind::Folder => RecursiveMode::Recursive,
        ShareKind::File => RecursiveMode::NonRecursive,
    };
    watcher.watch(&share.share.root, mode)?;

    tokio::spawn(async move {
        while let Some(first) = rx.recv().await {
            let mut change = Pending::default();
            change.add(&share.share, &first);
            let deadline = tokio::time::sleep(DEBOUNCE);
            tokio::pin!(deadline);
            loop {
                tokio::select! {
                    _ = &mut deadline => break,
                    next = rx.recv() => match next {
                        Some(event) => change.add(&share.share, &event),
                        None => break,
                    },
                }
            }
            if let Some(event) = change.finish() {
                let _ = events.send(event);
            }
        }
    });
    Ok(watcher)
}

#[derive(Default)]
struct Pending {
    paths: BTreeSet<String>,
    tree: bool,
}

impl Pending {
    fn add(&mut self, share: &Share, event: &notify::Event) {
        let structural = matches!(
            event.kind,
            EventKind::Create(_)
                | EventKind::Remove(_)
                | EventKind::Modify(notify::event::ModifyKind::Name(_))
        );
        for path in &event.paths {
            let Some(rel) = relative(share, path) else {
                continue;
            };
            if rel.is_empty() || in_skipped_dir(&rel) {
                continue;
            }
            // A single-file share only reports the file and its images.
            if let (ShareKind::File, Some(entry)) = (share.kind, &share.entry)
                && &rel != entry
                && !share.allows(path)
            {
                continue;
            }
            if is_listed(path) {
                self.paths.insert(rel);
                self.tree |= structural;
            } else if structural && path.extension().is_none() {
                // Probably a directory appearing or disappearing.
                self.tree = true;
            }
        }
    }

    fn finish(self) -> Option<ChangeEvent> {
        (!self.paths.is_empty() || self.tree).then(|| ChangeEvent {
            paths: self.paths.into_iter().collect(),
            tree: self.tree,
        })
    }
}

/// Event paths can arrive with or without the `\\?\` prefix that
/// canonicalisation adds on Windows, so try both forms.
fn relative(share: &Share, path: &Path) -> Option<String> {
    rel_path(&share.root, path).or_else(|| {
        let root = share.root.to_string_lossy();
        let plain = root.strip_prefix(r"\\?\")?;
        rel_path(Path::new(plain), path)
    })
}
