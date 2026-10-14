mod awake;
mod devices;
mod mdns;
mod net;
mod server;
mod share;
mod shell;
mod watch;
mod web;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use clap::{Parser, Subcommand};
use qrcode::QrCode;
use qrcode::render::unicode::Dense1x2;
use tokio::net::TcpListener;
use tokio::sync::broadcast;

use crate::devices::Registry;
use crate::net::AddrKind;
use crate::server::{AppState, Session, now_secs};
use crate::share::{Share, ShareKind};

const DEFAULT_PORT: u16 = 7878;

/// Share a markdown file or folder with the mdshare app, read-only, until you
/// press Ctrl+C.
#[derive(Parser, Debug)]
#[command(
    version,
    about,
    args_conflicts_with_subcommands = true,
    subcommand_negates_reqs = true
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    /// The .md file or folder to share.
    #[arg(required = true)]
    path: Option<PathBuf>,

    /// Stop sharing after this long, e.g. `90m` or `4h`.
    #[arg(long = "for", value_name = "DURATION", value_parser = humantime::parse_duration)]
    duration: Option<Duration>,

    /// Stop after this long with no phone connected, e.g. `30m`.
    #[arg(long, value_name = "DURATION", value_parser = humantime::parse_duration)]
    idle: Option<Duration>,

    /// Keep the laptop from idle-sleeping while sharing. Closing the lid still
    /// sleeps it unless the lid action is set to "Do nothing".
    #[arg(long)]
    keep_awake: bool,

    /// Port to listen on. Defaults to 7878, or the next free port.
    #[arg(long)]
    port: Option<u16>,

    /// Address to listen on. The default reaches Wi-Fi and Tailscale;
    /// `127.0.0.1` keeps the share on this machine (handy for testing).
    #[arg(long, default_value = "0.0.0.0")]
    bind: std::net::IpAddr,

    /// Name shown in the app. Defaults to the file or folder name.
    #[arg(long)]
    name: Option<String>,

    /// Don't announce the share on the local network.
    #[arg(long)]
    no_mdns: bool,

    /// Only let already-paired phones in; no QR code or pair code this time.
    #[arg(long)]
    no_pair: bool,

    /// Also print the pairing link as text (to paste on a phone without a camera).
    #[arg(long)]
    show_link: bool,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// List the phones paired with this laptop.
    Devices,
    /// Un-pair a phone so it can no longer connect.
    Unpair {
        /// Device id (or the start of it) from `mdshare devices`.
        #[arg(required_unless_present = "all")]
        id: Option<String>,
        /// Un-pair every phone.
        #[arg(long)]
        all: bool,
    },
    /// Add or remove "Share with mdshare" in the Windows Explorer right-click menu.
    ContextMenu {
        #[arg(value_enum)]
        action: MenuAction,
    },
}

#[derive(clap::ValueEnum, Clone, Copy, Debug)]
enum MenuAction {
    Install,
    Remove,
}

async fn bind(ip: std::net::IpAddr, port: Option<u16>) -> anyhow::Result<TcpListener> {
    let candidates: Vec<u16> = match port {
        Some(p) => vec![p],
        None => (DEFAULT_PORT..DEFAULT_PORT + 20).collect(),
    };
    let mut last_err = None;
    for p in candidates {
        match TcpListener::bind(SocketAddr::new(ip, p)).await {
            Ok(l) => return Ok(l),
            Err(e) => last_err = Some(e),
        }
    }
    Err(anyhow::anyhow!(
        "couldn't listen on a port: {}",
        last_err.unwrap()
    ))
}

/// What the QR code carries: everything a phone needs to pair once.
fn pair_link(server_id: &str, secret: &str, hosts: &[String], port: u16) -> String {
    format!(
        "mdshare://pair?id={server_id}&s={secret}&p={port}&h={}",
        hosts.join(",")
    )
}

fn print_qr(data: &str) {
    match QrCode::new(data.as_bytes()) {
        Ok(code) => {
            // Inverted so it reads correctly on a dark terminal.
            let art = code
                .render::<Dense1x2>()
                .dark_color(Dense1x2::Light)
                .light_color(Dense1x2::Dark)
                .quiet_zone(true)
                .build();
            for line in art.lines() {
                println!("  {line}");
            }
        }
        Err(e) => eprintln!("couldn't draw the QR code: {e}"),
    }
}

fn human(d: Duration) -> String {
    let secs = d.as_secs();
    match (secs / 3600, (secs % 3600) / 60) {
        (0, m) => format!("{m}m"),
        (h, 0) => format!("{h}h"),
        (h, m) => format!("{h}h {m}m"),
    }
}

fn ago(secs: u64) -> String {
    let d = now_secs().saturating_sub(secs);
    match d {
        0..60 => "just now".into(),
        60..3600 => format!("{}m ago", d / 60),
        3600..86400 => format!("{}h ago", d / 3600),
        _ => format!("{}d ago", d / 86400),
    }
}

fn run_command(cmd: Command) -> anyhow::Result<()> {
    let reg = Registry::load();
    match cmd {
        Command::Devices => {
            let list = reg.list();
            if list.is_empty() {
                println!("No phones paired yet. Run `mdshare <path>` and scan the QR code.");
            }
            for d in list {
                println!(
                    "{}  {:<24} paired {}, last seen {}",
                    d.id,
                    d.name,
                    ago(d.paired_at),
                    ago(d.last_seen)
                );
            }
        }
        Command::Unpair { id, all } => {
            let n = reg.remove(if all { None } else { id.as_deref() });
            println!("Un-paired {n} phone{}.", if n == 1 { "" } else { "s" });
        }
        Command::ContextMenu {
            action: MenuAction::Install,
        } => {
            shell::install()?;
            println!(
                "Added \"Share with mdshare\" to the right-click menu for folders and .md files."
            );
            println!(
                "On Windows 11 it's under \"Show more options\". It runs this copy of mdshare:"
            );
            println!("  {}", std::env::current_exe()?.display());
        }
        Command::ContextMenu {
            action: MenuAction::Remove,
        } => {
            shell::uninstall()?;
            println!("Removed \"Share with mdshare\" from the right-click menu.");
        }
    }
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    if let Some(cmd) = cli.command {
        return run_command(cmd);
    }
    let path = cli.path.as_deref().expect("required by clap");
    let share = Share::open(path, cli.name.clone())?;
    let devices = Registry::load();
    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "laptop".into());

    let magicdns = tokio::task::spawn_blocking(net::magicdns_name);
    let listener = bind(cli.bind, cli.port).await?;
    let port = listener.local_addr()?.port();
    let addrs = if cli.bind.is_unspecified() {
        net::local_addrs()
    } else {
        vec![net::Addr {
            host: cli.bind.to_string(),
            kind: if matches!(cli.bind, std::net::IpAddr::V4(v4) if net::is_tailscale(v4)) {
                AddrKind::Tailscale
            } else {
                AddrKind::Lan
            },
        }]
    };
    // A specific --bind address isn't reachable through MagicDNS.
    let magicdns = magicdns
        .await
        .ok()
        .flatten()
        .filter(|_| cli.bind.is_unspecified());

    let mut all_addrs = addrs.clone();
    all_addrs.extend(magicdns.iter().map(|h| net::Addr {
        host: h.clone(),
        kind: AddrKind::Tailscale,
    }));
    let mut hosts: Vec<String> = all_addrs.iter().map(|a| a.host.clone()).collect();
    if hosts.is_empty() {
        hosts.push("127.0.0.1".into());
    }

    let (events_tx, _) = broadcast::channel(64);
    let state = Arc::new(AppState::new(
        Session {
            share,
            devices,
            hostname: hostname.clone(),
            port,
            addrs: all_addrs,
            expires_at: cli.duration.map(|d| now_secs() + d.as_secs()),
            pairing: !cli.no_pair,
        },
        events_tx.clone(),
    ));

    let _watcher = match watch::spawn(state.clone(), events_tx) {
        Ok(w) => Some(w),
        Err(e) => {
            eprintln!("warning: live reload is off ({e})");
            None
        }
    };
    let _advert = if cli.no_mdns {
        None
    } else {
        match mdns::advertise(&state, &addrs) {
            Ok(a) => Some(a),
            Err(e) => {
                eprintln!("warning: not visible on Wi-Fi ({e}); use the QR code instead");
                None
            }
        }
    };
    let _awake = if cli.keep_awake {
        let guard = awake::KeepAwake::start();
        if guard.is_none() {
            eprintln!("warning: --keep-awake isn't supported on this platform");
        }
        guard
    } else {
        None
    };

    // Banner.
    let what = match state.share.kind {
        ShareKind::File => "file".to_string(),
        ShareKind::Folder => {
            let n = state.share.markdown_files().len();
            format!("folder, {n} markdown file{}", if n == 1 { "" } else { "s" })
        }
    };
    let paired = state.devices.list().len();
    println!();
    println!("  mdshare  sharing \"{}\" ({what})", state.share.name);
    println!();
    if cli.no_pair {
        println!("  Pairing is off; only phones paired before can connect.");
    } else {
        let link = pair_link(&state.server_id, &state.pair_secret, &hosts, port);
        print_qr(&link);
        if cli.show_link {
            println!("  {link}");
        }
        println!();
        println!("  New phone? Scan the QR code in the mdshare app, or pick this laptop");
        println!("  under Nearby and type the pair code. You only pair once.");
        println!();
        let code = &state.pair_code;
        println!("  Pair code   {} {}", &code[..3], &code[3..]);
    }
    if paired > 0 {
        println!(
            "  Paired      {paired} phone{} (they connect automatically)",
            if paired == 1 { "" } else { "s" }
        );
    }
    for a in &state.addrs {
        let label = match (&a.kind, a.host.parse::<std::net::Ipv4Addr>().is_ok()) {
            (AddrKind::Lan, _) => "Wi-Fi/LAN",
            (AddrKind::Tailscale, true) => "Tailscale",
            (AddrKind::Tailscale, false) => "MagicDNS",
        };
        println!("  {label:<11} {}:{port}", a.host);
    }
    println!(
        "  Browser     http://{}:{port}/?t={}",
        hosts[0], state.session_token
    );
    let mut stops = vec!["Ctrl+C".to_string()];
    if let Some(d) = cli.duration {
        stops.push(format!("after {}", human(d)));
    }
    if let Some(d) = cli.idle {
        stops.push(format!("after {} idle", human(d)));
    }
    println!("  Stops       {}", stops.join(", or "));
    if _awake.is_some() {
        println!(
            "  Keep-awake  on (no idle sleep; closing the lid still sleeps unless set to \"Do nothing\")"
        );
    }
    println!();

    let app = server::router(state.clone());
    let serve = axum::serve(listener, app.into_make_service());

    let deadline = async {
        match cli.duration {
            Some(d) => tokio::time::sleep(d).await,
            None => std::future::pending().await,
        }
    };
    let idle = async {
        let Some(limit) = cli.idle else {
            return std::future::pending().await;
        };
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            let quiet = now_secs().saturating_sub(state.last_activity.load(Ordering::Relaxed));
            if state.live_streams.load(Ordering::Relaxed) == 0 && quiet >= limit.as_secs() {
                return;
            }
        }
    };

    // Dropping the server future closes open connections, including live
    // reload streams, so shutdown is immediate.
    let reason = tokio::select! {
        res = serve => { res?; "server stopped" }
        _ = tokio::signal::ctrl_c() => "stopped",
        _ = deadline => "time's up",
        _ = idle => "idle",
    };
    // Persist last-seen times.
    state.devices.save();
    println!("  {reason}; no longer sharing.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_format() {
        let hosts = vec![
            "192.168.1.5".to_string(),
            "100.64.1.2".into(),
            "lap.ts.net".into(),
        ];
        assert_eq!(
            pair_link("SID", "sec", &hosts, 7878),
            "mdshare://pair?id=SID&s=sec&p=7878&h=192.168.1.5,100.64.1.2,lap.ts.net"
        );
    }

    #[test]
    fn durations() {
        assert_eq!(human(Duration::from_secs(4 * 3600)), "4h");
        assert_eq!(human(Duration::from_secs(90 * 60)), "1h 30m");
        assert_eq!(human(Duration::from_secs(300)), "5m");
    }

    #[test]
    fn cli_parses() {
        let devices = Cli::try_parse_from(["mdshare", "devices"]).unwrap();
        assert!(matches!(devices.command, Some(Command::Devices)));
        let c = Cli::try_parse_from(["mdshare", "docs", "--for", "4h"]).unwrap();
        assert_eq!(c.path.unwrap(), PathBuf::from("docs"));
        assert!(Cli::try_parse_from(["mdshare"]).is_err());
        assert!(Cli::try_parse_from(["mdshare", "unpair"]).is_err());
        assert!(Cli::try_parse_from(["mdshare", "unpair", "--all"]).is_ok());
        assert!(Cli::try_parse_from(["mdshare", "context-menu", "install"]).is_ok());
    }
}
