mod awake;
mod mdns;
mod net;
mod server;
mod share;
mod watch;
mod web;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use clap::Parser;
use qrcode::QrCode;
use qrcode::render::unicode::Dense1x2;
use rand::RngExt;
use tokio::net::TcpListener;
use tokio::sync::broadcast;

use crate::net::AddrKind;
use crate::server::{AppState, now_secs};
use crate::share::{Share, ShareKind};

const DEFAULT_PORT: u16 = 7878;

/// Share a markdown file or folder with the mdshare app, read-only, until you
/// press Ctrl+C.
#[derive(Parser, Debug)]
#[command(version, about)]
struct Cli {
    /// The .md file or folder to share.
    path: PathBuf,

    /// Stop sharing after this long, e.g. `90m` or `4h`.
    #[arg(long = "for", value_name = "DURATION", value_parser = humantime::parse_duration)]
    duration: Option<Duration>,

    /// Stop after this long with no phone connected, e.g. `30m`.
    #[arg(long, value_name = "DURATION", value_parser = humantime::parse_duration)]
    idle: Option<Duration>,

    /// Keep the laptop from sleeping while sharing (the screen may still turn off).
    #[arg(long)]
    keep_awake: bool,

    /// Port to listen on. Defaults to 7878, or the next free port.
    #[arg(long)]
    port: Option<u16>,

    /// Name shown in the app. Defaults to the file or folder name.
    #[arg(long)]
    name: Option<String>,

    /// Don't announce the share on the local network.
    #[arg(long)]
    no_mdns: bool,

    /// Use a one-off token for this session instead of this laptop's saved one.
    /// Phones paired before won't connect.
    #[arg(long, conflicts_with = "new_token")]
    ephemeral: bool,

    /// Replace this laptop's saved token, un-pairing every phone.
    #[arg(long)]
    new_token: bool,
}

fn random_string(len: usize) -> String {
    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    let mut rng = rand::rng();
    (0..len)
        .map(|_| CHARS[rng.random_range(0..CHARS.len())] as char)
        .collect()
}

fn config_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join("mdshare"))
    } else if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        Some(PathBuf::from(xdg).join("mdshare"))
    } else {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config").join("mdshare"))
    }
}

/// The laptop's saved token, so paired phones keep working across shares.
fn load_token(cli: &Cli) -> String {
    if cli.ephemeral {
        return random_string(24);
    }
    let Some(dir) = config_dir() else {
        return random_string(24);
    };
    let file = dir.join("token");
    if !cli.new_token
        && let Ok(saved) = std::fs::read_to_string(&file)
    {
        let saved = saved.trim();
        if saved.len() >= 20 && saved.chars().all(|c| c.is_ascii_alphanumeric()) {
            return saved.to_string();
        }
    }
    let token = random_string(24);
    if std::fs::create_dir_all(&dir)
        .and_then(|_| std::fs::write(&file, &token))
        .is_err()
    {
        eprintln!("warning: couldn't save the token to {}", file.display());
    }
    token
}

async fn bind(port: Option<u16>) -> anyhow::Result<TcpListener> {
    let candidates: Vec<u16> = match port {
        Some(p) => vec![p],
        None => (DEFAULT_PORT..DEFAULT_PORT + 20).collect(),
    };
    let mut last_err = None;
    for p in candidates {
        match TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], p))).await {
            Ok(l) => return Ok(l),
            Err(e) => last_err = Some(e),
        }
    }
    Err(anyhow::anyhow!(
        "couldn't listen on a port: {}",
        last_err.unwrap()
    ))
}

fn share_link(hosts: &[String], port: u16, token: &str) -> String {
    let mut link = format!("mdshare://{}:{port}/?t={token}", hosts[0]);
    if hosts.len() > 1 {
        link.push_str("&alt=");
        link.push_str(&hosts[1..].join(","));
    }
    link
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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let share = Share::open(&cli.path, cli.name.clone())?;
    let token = load_token(&cli);
    let pair_code = format!("{:06}", rand::rng().random_range(0..1_000_000u32));
    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "laptop".into());

    let magicdns = tokio::task::spawn_blocking(net::magicdns_name);
    let listener = bind(cli.port).await?;
    let port = listener.local_addr()?.port();
    let addrs = net::local_addrs();
    let magicdns = magicdns.await.ok().flatten();

    let mut hosts: Vec<String> = addrs.iter().map(|a| a.host.clone()).collect();
    hosts.extend(magicdns.clone());
    if hosts.is_empty() {
        hosts.push("127.0.0.1".into());
    }

    let expires_at = cli.duration.map(|d| now_secs() + d.as_secs());
    let (events_tx, _) = broadcast::channel(64);
    let mut all_addrs = addrs.clone();
    all_addrs.extend(magicdns.iter().map(|h| net::Addr {
        host: h.clone(),
        kind: AddrKind::Tailscale,
    }));
    let state = Arc::new(AppState::new(
        share,
        token.clone(),
        pair_code.clone(),
        hostname.clone(),
        port,
        all_addrs,
        expires_at,
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
        match mdns::advertise(&state.share.name, state.share.kind, &hostname, &addrs, port) {
            Ok(a) => Some(a),
            Err(e) => {
                eprintln!("warning: not visible in Nearby ({e}); scan the QR code instead");
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
    println!();
    println!("  mdshare  sharing \"{}\" ({what})", state.share.name);
    println!();
    print_qr(&share_link(&hosts, port, &token));
    println!();
    println!("  Scan the QR code in the mdshare app, or pick this laptop under Nearby");
    println!("  and enter the pair code.");
    println!();
    println!("  Pair code   {} {}", &pair_code[..3], &pair_code[3..]);
    for a in &addrs {
        let label = match a.kind {
            AddrKind::Lan => "Wi-Fi/LAN",
            AddrKind::Tailscale => "Tailscale",
        };
        println!("  {label:<11} {}:{port}", a.host);
    }
    if let Some(name) = &magicdns {
        println!("  {:<11} {name}:{port}", "MagicDNS");
    }
    println!("  Browser     http://{}:{port}/?t={token}", hosts[0]);
    let mut stops = vec!["Ctrl+C".to_string()];
    if let Some(d) = cli.duration {
        stops.push(format!("after {}", human(d)));
    }
    if let Some(d) = cli.idle {
        stops.push(format!("after {} idle", human(d)));
    }
    println!("  Stops       {}", stops.join(", or "));
    if _awake.is_some() {
        println!("  Keep-awake  on (the laptop won't sleep while sharing)");
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
            share_link(&hosts, 7878, "tok"),
            "mdshare://192.168.1.5:7878/?t=tok&alt=100.64.1.2,lap.ts.net"
        );
        assert_eq!(
            share_link(&hosts[..1], 1, "x"),
            "mdshare://192.168.1.5:1/?t=x"
        );
    }

    #[test]
    fn durations() {
        assert_eq!(human(Duration::from_secs(4 * 3600)), "4h");
        assert_eq!(human(Duration::from_secs(90 * 60)), "1h 30m");
        assert_eq!(human(Duration::from_secs(300)), "5m");
    }
}
