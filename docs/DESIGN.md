# mdshare design

## Goals

- Share a single `.md` file or a whole folder (for example, an agent's context docs) when you need to, not all the time.
- Read it on Android with a polished, native-feeling reader.
- Work on the same Wi-Fi **and** away from home over Tailscale.
- Keep the laptop side lightweight: one small binary with a few MB of RAM.

## Server (`server/`, Rust)

- `mdshare <path> [--for 4h] [--keep-awake] [--port 7878]`
  - Prints a QR code and a pairing token. Stops on Ctrl+C or when the `--for` deadline passes.
  - With `--keep-awake`, it stops the laptop from sleeping while the share is active (Windows `SetThreadExecutionState`). Use it when you share before leaving the house.
- Stack: `axum` + `tokio`, `notify` (file watching), `mdns-sd` (LAN discovery), `qrcode`.
- Sends **raw** files only. The app does all rendering.
- API (every request needs `Authorization: Bearer <token>`):
  - `GET /api/info`: share name, host, and whether it's a single file or a folder
  - `GET /api/tree`: file tree (`.md` files plus image and asset files)
  - `GET /api/file?path=…`: raw file contents (path is relative to the share root)
  - `GET /api/events`: SSE stream of change events from the file watcher (live reload)
- Security: read-only access, canonicalised paths that must stay inside the share root, and a random token for each session. Without the token every request gets a 401.

### Reachability

| Mode | How the phone finds the laptop |
|---|---|
| Same Wi-Fi | mDNS `_mdshare._tcp`. The app lists shares automatically. |
| Tailscale | mDNS doesn't cross a tailnet. The QR code / share link includes every reachable address: LAN IP, Tailscale `100.x` IP, and the MagicDNS name. The app saves the host and tries each address. |

The server binds to `0.0.0.0` so it's reachable on both the LAN and the Tailscale interface. A share link looks like
`mdshare://<host>:<port>?t=<token>&alt=<ip1>,<ip2>`.

## App (`app/`, Expo + gluestack-ui v5)

- UI shell: Expo Router + gluestack-ui v5 (NativeWind / Tailwind v4) for a polished, consistent component system.
- Markdown rendering: `react-native-webview` running markdown-it, Shiki (code highlighting), KaTeX (math), and Mermaid (diagrams), with a themed reading stylesheet.
- Features:
  - Shares list (discovered via mDNS plus saved Tailscale hosts) and a QR code scanner for pairing
  - Folder browser that opens links between `.md` files inside the app
  - Table of contents drawer, reading progress, and the last reading position remembered per file
  - Light, dark, and sepia themes, adjustable font size and line width, and two-pane layout on tablets
  - Live reload over SSE that keeps your scroll position
  - Offline cache of files you've already opened
  - Standalone reader: handles "Open with" for `.md` files and can open any local folder through the Storage Access Framework (SAF)

## Milestones

1. **MVP:** server (`info`/`tree`/`file`, token, QR code) and an app that pairs by QR code, browses folders, and renders markdown.
2. **v1:** live reload, mDNS discovery, Tailscale addresses, table of contents and search, themes, offline cache, "Open with" for local files.
3. **v2:** right-click "Share via mdshare" in Windows Explorer, a web page fallback served by the binary, and multiple saved laptops.
