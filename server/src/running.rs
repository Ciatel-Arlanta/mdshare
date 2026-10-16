//! Other shares running on this laptop. Each `mdshare` process serves one
//! share on its own port; they find each other through small files in the
//! config directory, so a phone that reaches any of them learns about all.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::devices::config_dir;
use crate::share::ShareKind;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ShareInfo {
    pub share_id: String,
    pub name: String,
    pub kind: ShareKind,
    pub port: u16,
}

#[derive(Serialize, Deserialize)]
struct Entry {
    #[serde(flatten)]
    info: ShareInfo,
    /// Address the share listens on, to check it's still running.
    bind: IpAddr,
}

/// Removes this share's file when the process exits normally. A killed
/// process leaves it behind; `others` drops it once nothing listens there.
pub struct Registration {
    file: PathBuf,
}

impl Drop for Registration {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.file);
    }
}

pub fn dir() -> Option<PathBuf> {
    config_dir().map(|d| d.join("running"))
}

pub fn register(dir: &Path, info: ShareInfo, bind: IpAddr) -> Option<Registration> {
    std::fs::create_dir_all(dir).ok()?;
    let file = dir.join(format!("{}.json", info.port));
    let body = serde_json::to_vec(&Entry { info, bind }).ok()?;
    std::fs::write(&file, body).ok()?;
    Some(Registration { file })
}

/// Every share running on this laptop except the one on `own_port`.
pub fn others(dir: &Path, own_port: u16) -> Vec<ShareInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for path in entries.flatten().map(|e| e.path()) {
        let Some(entry) = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Entry>(&b).ok())
        else {
            continue;
        };
        if entry.info.port == own_port {
            continue;
        }
        let ip = match entry.bind {
            IpAddr::V4(v4) if v4.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V6(v6) if v6.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
            ip => ip,
        };
        let addr = SocketAddr::new(ip, entry.info.port);
        if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
            out.push(entry.info);
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }
    out.sort_by_key(|s| s.port);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn info(port: u16) -> ShareInfo {
        ShareInfo {
            share_id: format!("id{port}"),
            name: format!("share {port}"),
            kind: ShareKind::Folder,
            port,
        }
    }

    #[test]
    fn lists_live_siblings_and_drops_stale_ones() {
        let dir = std::env::temp_dir().join(format!("mdshare-running-{}", rand::random::<u32>()));
        let live = TcpListener::bind("127.0.0.1:0").unwrap();
        let live_port = live.local_addr().unwrap().port();
        let dead_port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let localhost = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let own = register(&dir, info(1), localhost).unwrap();
        let _live = register(&dir, info(live_port), localhost).unwrap();
        let _dead = register(&dir, info(dead_port), localhost).unwrap();

        assert_eq!(others(&dir, 1), vec![info(live_port)]);
        assert!(!dir.join(format!("{dead_port}.json")).exists());

        drop(own);
        assert!(!dir.join("1.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
