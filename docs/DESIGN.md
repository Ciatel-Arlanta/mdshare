# mdshare design

## Goals

- Share a single `.md` file or a whole folder (for example, an agent's context docs) when you need to, not all the time.
- Read it on Android with a polished, native-feeling reader.
- Work on the same Wi-Fi **and** away from home over Tailscale.
- Pair a phone once, then never think about addresses or codes again.
- Keep the laptop side lightweight: one ~2 MB binary using a few MB of RAM.

## Server (`server/`, Rust)

```
mdshare <path> [--for 4h] [--idle 30m] [--keep-awake] [--port 7878] [--name NAME] [--no-mdns] [--no-pair]
mdshare devices              # list paired phones
mdshare unpair <id> | --all  # revoke a phone
```

- Each run serves one share on its own port (7878, or the next free one), so a laptop can share several files and folders at once. Every share has a stable `share_id` derived from its path, and registers itself in `%APPDATA%\mdshare\running\<port>.json` while it runs.
- Prints a QR code and a 6-digit pair code. Stops on Ctrl+C, when the `--for` deadline passes, or after `--idle` with no phone connected.
- `--keep-awake` stops idle sleep while the share is active (Windows `SetThreadExecutionState`). It doesn't override the lid: closing the lid sleeps the laptop (Modern Standby suspends the server and Tailscale) unless the lid action is "Do nothing". See [TAILSCALE.md](TAILSCALE.md).
- Stack: `axum` + `tokio`, `notify` (file watching), `mdns-sd` (LAN discovery), `qrcode`.
- Sends **raw** files only. The app does all rendering.

### API

Every request except `ping` and `pair` needs a token, sent as `Authorization: Bearer <token>`, as a `?t=` query parameter (for `<img src>`), or as the browser page's cookie.

| Endpoint | |
|---|---|
| `GET /api/ping` | `{app, version, server_id, name, host, share_id, kind, port, shares}`. Unauthenticated, so the app can tell which address answers and that it's the right laptop. With a paired phone's token, `shares` also lists the laptop's other running shares (`{share_id, name, kind, port}`), so reaching any one of them finds the rest; without one it's left out. |
| `POST /api/pair` | `{secret}` (from the QR code) or `{code}` (6 digits), plus `device_name`. Returns this phone's own token, plus `server_id` and every address. |
| `GET /api/info` | Share name, kind (`file`/`folder`), entry file, host, port, addresses, expiry. |
| `GET /api/tree` | Nested tree of markdown files plus images, `.txt` and `.pdf`. Skips `.git`, `node_modules`, `target` and similar. |
| `GET /api/file?path=…` | Raw contents with an `ETag`; answers `If-None-Match` with 304. Also at `/raw/<path>`. |
| `GET /api/search?q=…` | Case-insensitive search across markdown files: `{hits: [{path, line, text}]}`. |
| `GET /api/events` | SSE stream: `hello`, then `change` events `{paths, tree}` (200 ms debounce) for live reload. |
| `GET /?t=…` | Minimal browser page (sets a cookie, then lists and shows files). |

### Security

- Read-only. Paths must be relative, can't contain `..`, `\` or `:` (NTFS streams), and must canonicalise to a file inside the share root. Only listed file types are served, never `.env`, keys or source code.
- For a single-file share, only that file and the images it links to are served, even if it sits in a broad folder like the home directory.
- Pairing: the QR code carries a random 24-character secret for the current session. The 6-digit code is for phones that found the laptop under Nearby; ten wrong codes lock it for the session (the QR secret still works). `--no-pair` turns pairing off entirely.
- Each phone gets its own 32-character token. The laptop stores only its SHA-256 hash in `%APPDATA%\mdshare\mdshare.json` (`~/.config/mdshare` elsewhere), next to a permanent random `server_id`. `mdshare unpair` takes effect immediately, even while a share is running.
- Responses carry `Referrer-Policy: no-referrer`, so a token in a URL never leaks to other sites. SVGs are served with a CSP that blocks scripts.

### Reachability: pair once, reconnect anywhere

| Channel | How the phone finds the laptop |
|---|---|
| B: same Wi-Fi | Each share advertises `_mdshare._tcp` over mDNS with `id=<server_id>` and `share=<share_id>` in the TXT record. A paired phone matches the id, so it finds the laptop even after DHCP gives it a new address. Unpaired laptops show up as "tap to pair". |
| Last known address | The address that worked last time is tried next. |
| A: Tailscale | mDNS doesn't cross a tailnet, so pairing saves every address: LAN IP, Tailscale `100.x` IP and MagicDNS name (from `tailscale status --json`). Away from home the Tailscale address answers. |

The app probes all candidates in parallel with `/api/ping`, takes the first that answers with the right `server_id` (preferring the wanted share; if a different share answers, its `shares` list gives the wanted one's current port), then refreshes its saved addresses from `/api/info`. The server binds to `0.0.0.0`, so it answers on both the LAN and the Tailscale interface.

QR link format: `mdshare://pair?id=<server_id>&s=<secret>&p=<port>&h=<host1>,<host2>,…`. Scanning it with the system camera also opens the app.

## App (`app/`, Expo + gluestack-ui v5)

- UI: Expo Router + gluestack-ui v5 (NativeWind v5 / Tailwind v4), with lucide icons.
- State: zustand persisted to AsyncStorage. Device tokens live in `expo-secure-store`.
- Discovery: `react-native-zeroconf`. Live reload: `react-native-sse`. QR: `expo-camera`.
- Rendering: `react-native-webview` loads a reader page bundled into the APK's assets (`app/reader`). The page uses markdown-it (footnotes, task lists, `==mark==`, GitHub alerts, front matter), highlight.js, KaTeX and Mermaid (loaded only when a diagram appears), and sanitises everything with DOMPurify under a strict CSP. Every block carries its source line, so the reading position survives edits and live reloads.
- Features:
  - Home: a row per share on each paired laptop with live status (long-press a stopped share to forget it), nearby unpaired laptops, phone folders and files
  - Browse: file tree, filter by name, full-text search, two-pane layout on tablets
  - Reader: light/sepia/dark/black themes, font, size, line width and spacing, table of contents, find in page, progress bar, copy buttons on code blocks, links between `.md` files open in the app
  - Offline copies of every tree and file you've opened, used automatically when the laptop is unreachable
  - Standalone reader: "Open with" for `.md` files, plus any phone folder through the Storage Access Framework

## Milestones

1. **MVP (done):** server, QR pairing, folder browsing, markdown rendering.
2. **v1 (done):** pair once with per-device tokens, live reload, mDNS discovery, Tailscale addresses, table of contents and search, themes, offline cache, "Open with" for local files.
3. **v2:** right-click "Share with mdshare" in Windows Explorer (done: `mdshare context-menu install`), a richer browser page served by the binary, and quick switching between multiple laptops.
