# mdshare

Share markdown files or folders from your laptop and read them on your Android phone or tablet, either on the same Wi-Fi or from anywhere over Tailscale.

The laptop side is a small Rust binary that you start when you want to share and stop when you're done. Nothing runs in the background otherwise. The phone side is a markdown reader app with a proper reading view (code highlighting, math, Mermaid diagrams, themes). It can also open `.md` files and folders that are already on the phone.

## Use it

On the laptop:

```powershell
mdshare .\docs                      # share a folder
mdshare plan.md --for 4h --keep-awake  # share one file for 4 hours and keep the laptop awake
```

The first time, scan the QR code with the app (or pick the laptop under Nearby and type the 6-digit code). The phone is now paired. Later shares from that laptop show up in the app by themselves: over Wi-Fi via mDNS, or over Tailscale when you're away.

```powershell
mdshare devices        # paired phones
mdshare unpair <id>    # revoke one (or --all)
mdshare context-menu install   # add "Share with mdshare" to the Explorer right-click menu
```

## Layout

```
server/   Rust CLI: `mdshare <path>` serves a file or folder (read-only)
app/      Android reader: Expo (React Native) + gluestack-ui v5
docs/     Design notes
```

See [docs/DESIGN.md](docs/DESIGN.md) for the architecture, API and security model, and [docs/TAILSCALE.md](docs/TAILSCALE.md) for reading away from home.

## Build

- Server: `cd server && cargo build --release`. The binary is `server/target/release/mdshare.exe`; copy it somewhere on your `PATH`.
- App: see [app/README.md](app/README.md).
