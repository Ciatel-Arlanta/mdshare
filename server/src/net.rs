//! Finding the addresses a phone can reach this laptop on.

use std::net::Ipv4Addr;
use std::process::Command;
use std::time::Duration;

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AddrKind {
    Lan,
    Tailscale,
}

#[derive(Serialize, Clone, Debug)]
pub struct Addr {
    pub host: String,
    pub kind: AddrKind,
}

/// 100.64.0.0/10, the CGNAT range Tailscale assigns from.
pub fn is_tailscale(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    a == 100 && (64..128).contains(&b)
}

/// Private and Tailscale IPv4 addresses, LAN first. Link-local, loopback and
/// virtual adapters (WSL, Hyper-V, Docker) are skipped where recognisable.
pub fn local_addrs() -> Vec<Addr> {
    let mut lan = Vec::new();
    let mut ts = Vec::new();
    for iface in if_addrs::get_if_addrs().unwrap_or_default() {
        let std::net::IpAddr::V4(ip) = iface.ip() else {
            continue;
        };
        if ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() {
            continue;
        }
        let name = iface.name.to_lowercase();
        if is_tailscale(ip) {
            ts.push(Addr {
                host: ip.to_string(),
                kind: AddrKind::Tailscale,
            });
        } else if ip.is_private() && !is_virtual_adapter(&name) {
            lan.push(Addr {
                host: ip.to_string(),
                kind: AddrKind::Lan,
            });
        }
    }
    // Real Wi-Fi/Ethernet networks are almost always 192.168.x or 10.x; prefer
    // them over 172.16/12, which is mostly Docker and VM bridges.
    lan.sort_by_key(|a| a.host.starts_with("172."));
    lan.extend(ts);
    lan
}

fn is_virtual_adapter(name: &str) -> bool {
    [
        "vethernet",
        "wsl",
        "hyper-v",
        "docker",
        "virtualbox",
        "vmware",
        "vbox",
        "br-",
        "veth",
    ]
    .iter()
    .any(|v| name.contains(v))
}

/// The MagicDNS name of this machine, e.g. `laptop.tail1234.ts.net`, if the
/// Tailscale CLI is installed and logged in.
pub fn magicdns_name() -> Option<String> {
    let mut cmd = Command::new("tailscale");
    cmd.args(["status", "--json", "--peers=false"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let output = wait_with_timeout(child, Duration::from_secs(3))?;
    let json: serde_json::Value = serde_json::from_slice(&output).ok()?;
    if json["BackendState"].as_str() != Some("Running") {
        return None;
    }
    let name = json["Self"]["DNSName"].as_str()?.trim_end_matches('.');
    (!name.is_empty()).then(|| name.to_string())
}

/// Reads the child's stdout on a helper thread so a full pipe can't stall it,
/// and kills the child if it takes longer than `timeout`.
fn wait_with_timeout(mut child: std::process::Child, timeout: Duration) -> Option<Vec<u8>> {
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        std::io::Read::read_to_end(&mut stdout, &mut out).map(|_| out)
    });
    let start = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let out = reader.join().ok()?.ok()?;
    status.success().then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tailscale_range() {
        assert!(is_tailscale("100.64.0.1".parse().unwrap()));
        assert!(is_tailscale("100.101.102.103".parse().unwrap()));
        assert!(is_tailscale("100.127.255.255".parse().unwrap()));
        assert!(!is_tailscale("100.128.0.1".parse().unwrap()));
        assert!(!is_tailscale("100.63.0.1".parse().unwrap()));
        assert!(!is_tailscale("192.168.1.10".parse().unwrap()));
    }
}
