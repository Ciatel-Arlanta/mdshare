# Reading away from home with Tailscale

On the same Wi-Fi, the app finds the laptop by itself. Away from home your phone can't reach the laptop's Wi-Fi address, so you need a private network that links both devices wherever they are. [Tailscale](https://tailscale.com) does this for free on personal accounts.

mdshare needs no extra setup for Tailscale. The laptop includes its Tailscale address in the pairing QR code, and the app tries that address whenever Wi-Fi doesn't answer.

## One-time setup

1. **Laptop:** install Tailscale from <https://tailscale.com/download> and sign in.
2. **Phone:** install Tailscale from the Play Store and sign in with the **same account**.
3. Check that both devices show up in the Tailscale app as *Connected*.
4. **Pair (or re-pair) the phone while Tailscale is running on the laptop.** Start a share (`mdshare <folder>`) and check that the terminal shows a `Tailscale 100.x.y.z` line, and usually a `MagicDNS …ts.net` line. Then scan the QR code. If you paired before installing Tailscale, you don't need to pair again: the next time the phone connects over Wi-Fi it picks up the new addresses on its own.

## Sharing before you leave

```powershell
mdshare .\docs --for 6h --keep-awake
```

- `--keep-awake` stops the laptop from going to sleep while it's sharing. Closing the lid can still put it to sleep, depending on the "When I close the lid" setting under Windows power options. Leave the lid open, or set that option to *Do nothing* when plugged in.
- `--for 6h` stops the share after six hours, so it doesn't run forever.

Out of the house, open the app with Tailscale connected on the phone. The laptop shows up as *Sharing · Tailscale*. Live reload works the same as at home.

## If it doesn't connect

- The phone's Tailscale app must be **connected**. It disconnects if you turn it off or if another VPN takes over.
- On the laptop, run `tailscale status` and check that it lists your phone.
- The first time `mdshare` runs, Windows asks whether to allow it on networks; allow it. If the phone reaches it on Wi-Fi but not over Tailscale, open *Windows Security → Firewall & network protection → Allow an app through firewall* and make sure `mdshare` is ticked for the network type the Tailscale adapter uses.
- Documents you've already opened stay readable offline as "saved copies", even without a connection.
