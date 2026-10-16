//! Other shares running on this laptop. Each `mdshare` process serves one
//! share on its own port; they find each other through small files in the
//! config directory, so a phone that reaches any of them learns about all.

use std::io::{Read, Write};
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
/// process leaves it behind; `others` drops it once that port stops answering
/// as that share.
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
        if answers_as(SocketAddr::new(ip, entry.info.port), &entry.info.share_id) {
            out.push(entry.info);
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }
    out.sort_by_key(|s| s.port);
    out
}

/// Whether `addr` is still that share, not some other program that took the
/// port after mdshare was killed.
fn answers_as(addr: SocketAddr, share_id: &str) -> bool {
    let timeout = Duration::from_millis(500);
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, timeout) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    if stream
        .write_all(
            b"GET /api/ping HTTP/1.0
Host: localhost

",
        )
        .is_err()
    {
        return false;
    }
    let mut body = Vec::new();
    let _ = stream.take(16 * 1024).read_to_end(&mut body);
    String::from_utf8_lossy(&body).contains(&format!("\"share_id\":\"{share_id}\""))
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

    /// Answers one request per connection like `/api/ping` would.
    fn fake_share(listener: TcpListener, share_id: String) {
        std::thread::spawn(move || {
            for mut conn in listener.incoming().flatten() {
                let mut buf = [0u8; 1024];
                let _ = conn.read(&mut buf);
                let body = format!("{{\"app\":\"mdshare\",\"share_id\":\"{share_id}\"}}");
                let _ = write!(
                    conn,
                    "HTTP/1.0 200 OK

{body}"
                );
            }
        });
    }

    #[test]
    fn lists_live_siblings_and_drops_stale_ones() {
        let dir = std::env::temp_dir().join(format!("mdshare-running-{}", rand::random::<u32>()));
        let live = TcpListener::bind("127.0.0.1:0").unwrap();
        let live_port = live.local_addr().unwrap().port();
        fake_share(live, format!("id{live_port}"));
        // Another program took the port of a share that was killed.
        let impostor = TcpListener::bind("127.0.0.1:0").unwrap();
        let impostor_port = impostor.local_addr().unwrap().port();
        fake_share(impostor, "someone-else".into());
        let dead_port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let localhost = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let own = register(&dir, info(1), localhost).unwrap();
        let _live = register(&dir, info(live_port), localhost).unwrap();
        let _dead = register(&dir, info(dead_port), localhost).unwrap();
        let _impostor = register(&dir, info(impostor_port), localhost).unwrap();

        assert_eq!(others(&dir, 1), vec![info(live_port)]);
        assert!(!dir.join(format!("{dead_port}.json")).exists());
        assert!(!dir.join(format!("{impostor_port}.json")).exists());

        drop(own);
        assert!(!dir.join("1.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
