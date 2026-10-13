# mdshare

Share markdown files or folders from your laptop and read them on your phone or tablet, either on the same Wi-Fi or from anywhere over Tailscale.

The laptop side is a small Rust binary that you start when you want to share and stop when you're done. Nothing runs in the background otherwise. The phone side is a markdown reader app that can also open local `.md` files directly.

## Layout

```
server/   Rust CLI: `mdshare <path>` serves a file or folder (read-only)
app/      Mobile reader: Expo (React Native) + gluestack-ui v5
docs/     Design notes and decisions
```

See [docs/DESIGN.md](docs/DESIGN.md) for the architecture.
