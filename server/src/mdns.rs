//! LAN discovery: advertises the share as `_mdshare._tcp` so the app can list
//! it without typing an address. The token is never advertised.

use mdns_sd::{ServiceDaemon, ServiceInfo};

use crate::net::{Addr, AddrKind};
use crate::server::API_VERSION;
use crate::share::ShareKind;

pub const SERVICE_TYPE: &str = "_mdshare._tcp.local.";

pub struct Advert {
    daemon: ServiceDaemon,
    fullname: String,
}

pub fn advertise(
    share_name: &str,
    kind: ShareKind,
    hostname: &str,
    addrs: &[Addr],
    port: u16,
) -> anyhow::Result<Advert> {
    let ips: Vec<&str> = addrs
        .iter()
        .filter(|a| a.kind == AddrKind::Lan)
        .map(|a| a.host.as_str())
        .collect();
    anyhow::ensure!(!ips.is_empty(), "no LAN address to advertise on");

    let daemon = ServiceDaemon::new()?;
    let instance = truncate(&format!("{share_name} on {hostname}"), 63);
    let kind = match kind {
        ShareKind::File => "file",
        ShareKind::Folder => "folder",
    };
    let version = API_VERSION.to_string();
    let props = [
        ("v", version.as_str()),
        ("name", share_name),
        ("host", hostname),
        ("kind", kind),
    ];
    let host_label: String = hostname
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let info = ServiceInfo::new(
        SERVICE_TYPE,
        &instance,
        &format!("{host_label}.local."),
        &ips[..],
        port,
        &props[..],
    )?;
    let fullname = info.get_fullname().to_string();
    daemon.register(info)?;
    Ok(Advert { daemon, fullname })
}

impl Drop for Advert {
    fn drop(&mut self) {
        // Send a goodbye packet so phones drop the entry right away.
        if let Ok(rx) = self.daemon.unregister(&self.fullname) {
            let _ = rx.recv_timeout(std::time::Duration::from_millis(500));
        }
        let _ = self.daemon.shutdown();
    }
}

fn truncate(s: &str, max_bytes: usize) -> String {
    let mut end = s.len().min(max_bytes);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}
