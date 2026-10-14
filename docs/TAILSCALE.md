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

- `--keep-awake` stops the laptop from **idle** sleeping while it shares. It can't stop the sleep that closing the lid causes, and most Windows 11 laptops then enter Modern Standby, which freezes both mdshare and Tailscale. To read while the lid is shut, open *Control Panel → Power Options → Choose what closing the lid does* and set **When I close the lid** to **Do nothing**, at least for *Plugged in*. Otherwise leave the lid open; the screen can still turn off.
- `--for 6h` stops the share after six hours, so it doesn't run forever.

Out of the house, open the app with Tailscale connected on the phone. On the home screen the laptop shows "Sharing from … · Tailscale". Live reload works the same as at home.

## Windows Firewall

The first time `mdshare` runs, Windows asks whether to allow it on networks. Approving the prompt needs an administrator.

- **Tailscale:** works whichever box you tick. Tailscale puts its adapter on a *Private* network and adds its own `Tailscale-In` allow rule for traffic to your Tailscale address.
- **Home Wi-Fi:** depends on how Windows classifies that network. Check under *Settings → Network & internet → Wi-Fi → (your network)*. If it says **Public network**, the phone can only reach mdshare over Wi-Fi if you tick **Public networks** in the prompt. The alternative is to switch that Wi-Fi to **Private network**, which is the better choice for a home network. mdshare still requires a paired token either way.
- To change your answer later, go to *Windows Security → Firewall & network protection → Allow an app through firewall*.

## If it doesn't connect

- The phone's Tailscale app must be **connected**. It disconnects if you turn it off or if another VPN takes over. If the phone keeps dropping it, set Tailscale's battery usage to *Unrestricted*.
- On the laptop, `tailscale status` should list your phone. Also check that **Allow incoming connections** is on in the Tailscale menu (not "Shields up").
- `*.ts.net` names failing while `100.x` addresses work is usually Android's **Private DNS** setting conflicting with Tailscale DNS. The app tries the `100.x` address too, so this rarely matters. To fix names, turn Private DNS off, or keep "Use Tailscale DNS" enabled in the Tailscale app.
- mDNS (the automatic "Nearby" discovery) doesn't cross Tailscale; that's expected. Away from home the app uses the addresses it saved at pairing.
- Documents you've already opened stay readable offline as "saved copies", even without a connection.
