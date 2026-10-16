//! LAN discovery: advertises the share as `_mdshare._tcp` so the app can list
//! it without typing an address. The token is never advertised.

use mdns_sd::{ServiceDaemon, ServiceInfo};

use crate::net::{Addr, AddrKind};
use crate::server::{API_VERSION, AppState};
use crate::share::ShareKind;

pub const SERVICE_TYPE: &str = "_mdshare._tcp.local.";

pub struct Advert {
    daemon: ServiceDaemon,
    fullname: String,
}

pub fn advertise(state: &AppState, addrs: &[Addr]) -> anyhow::Result<Advert> {
    let (share_name, hostname, port) = (&state.share.name, &state.hostname, state.port);
    let ips: Vec<&str> = addrs
        .iter()
        .filter(|a| a.kind == AddrKind::Lan)
        .map(|a| a.host.as_str())
        .collect();
    anyhow::ensure!(!ips.is_empty(), "no LAN address to advertise on");

    let daemon = ServiceDaemon::new()?;
    // Unique per port: two shares can have the same name.
    let suffix = format!(" ({port})");
    let instance = truncate(&format!("{share_name} on {hostname}"), 63 - suffix.len()) + &suffix;
    let kind = match state.share.kind {
        ShareKind::File => "file",
        ShareKind::Folder => "folder",
    };
    let version = API_VERSION.to_string();
    let props = [
        ("v", version.as_str()),
        // Lets a paired phone recognise this laptop whatever its IP is today.
        ("id", state.server_id.as_str()),
        // Tells apart several shares running on the same laptop.
        ("share", state.share.id.as_str()),
        ("name", share_name.as_str()),
        ("host", hostname.as_str()),
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
