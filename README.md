# OpenGate VPN — free browser VPN extension

A free VPN extension for Chrome, Edge, Brave, Vivaldi and other Chromium browsers.

**Zero setup:** install the extension, press the power button, done. No accounts, no server lists to import, nothing to install on your computer.

- **Free servers found automatically.** On install and every 30 minutes, OpenGate downloads 18 public free proxy lists (jetkai, monosans, roosterkid, vakhov, prxchk, Proxifly, ProxyScrape, Geonode and more). Proxies that several lists agree on are tested first.
- **Only servers that really work.** Each one must load a Cloudflare test page over HTTPS with a valid certificate. That proves it works for secure sites and doesn't tamper with traffic, and it shows the server's real country.
- **Fast, with automatic failover.** You're connected as soon as the first working servers are found, usually in 10–20 seconds. Auto mode uses the fastest server and keeps backups ready. While you're connected, the servers in use are re-checked every 2 minutes, and dead ones are replaced without interrupting you.
- **Choose a country.** Use the Location menu on the Home screen, or keep "Fastest".
- **Targeted website mode.** Choose **"Only my site list"** and only those sites (and their subdomains) go through the VPN, so only they see a different IP. Everything else keeps your normal, fast connection. There are one-click presets for YouTube, Instagram, X, Discord, Telegram Web, ChatGPT and more, plus an "Add the site in this tab" button.
- **Full mode.** Choose **"All sites"** to send all browser traffic through the VPN.
- **No paid plans, ever.** No accounts, sign-ups, ads or tracking. Your settings stay in your browser.

## Install (1 minute)

1. Download this repository (Code → Download ZIP) and unzip it.
2. Open `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `extension` folder.
5. Click the OpenGate icon and press the power button. The first time, it takes about 10–20 seconds to find working free servers.
6. Press **Check my IP** to confirm it works.

## How it works

```
browser ──(only your sites, or everything)──► fastest free server (+ backups) ──► website
```

The extension sets your browser's proxy rules. To test hundreds of servers quickly, it sends test requests to Cloudflare test addresses through each server and times them. Your real browsing is never sent through a server that is still being tested.

### Why not VPN Gate and similar sites?

[VPN Gate](https://www.vpngate.net/) and similar free VPN sites hand out **OpenVPN / L2TP / SSTP / WireGuard** servers. Browsers can't connect to those, and Chrome extensions aren't allowed to run VPN software, so no browser extension can use them. Use the official VPN Gate client (or OpenVPN) for those. This extension uses free **SOCKS5 and HTTP proxies**, which is what a browser can use directly.

## Optional: your own servers (advanced)

You don't need this. But if you have your own VLESS / VMess / Trojan / Shadowsocks servers (for example a file like `AetrisVPN.txt`), open **Servers → Advanced: add your own servers**.

Plain `http://` and `socks5://` proxies work right away. VLESS and the other formats need **Xray-core**, because browsers can't speak those protocols. A one-time helper runs Xray for the extension:

- **Windows:** double-click `helper\install_windows.bat` (needs Python 3: `winget install Python.Python.3.12`)
- **macOS / Linux:** `bash helper/install.sh`

The helper only accepts commands from this extension (ID `aekgcagkmfabhjpmnhaaepiljnnhmcbp`). To remove it, run the installer with `--uninstall` (`-Uninstall` on Windows).

## Unblocking specific sites (targeted mode)

1. Go to **Sites** and add domains, such as `youtube.com`, or click a Quick add preset.
2. On **Home**, choose **Only my site list** and connect.
3. While browsing, open the popup and click **Use VPN here** to add the current site.

Only those sites change IP. Your bank, local sites and everything else stay on your normal connection.

Tip: some sites load videos or images from other domains, for example YouTube uses `googlevideo.com`. If a site only half-loads, add its CDN domains too. The presets already include them.

## Tips

- **Pick a server outside your country** to unblock sites blocked there. Use Settings → *Auto mode: country*, or pick a server by hand in the Servers list.
- Free servers come and go. The list refreshes every 30 minutes on its own; press **Find fastest free servers** to refresh now.
- Free public servers are often slower than paid VPNs. Targeted mode keeps everything else at full speed.
- Already using v2rayN, Hiddify, Nekoray or sing-box? Tick **"I run Xray… myself"** in Settings, set the same local SOCKS port, and OpenGate will only handle the per-site routing.

## Privacy and safety

- **Free public servers are run by unknown people.** Secure (HTTPS) sites stay encrypted end to end, and OpenGate only keeps servers that pass a secure-site check. Still, avoid banking and other sensitive logins through free servers. Targeted mode is the safest way to use them: only the sites you list go through them.
- In targeted mode, only the listed sites use the VPN, which is by design.
- The helper only accepts commands from this extension's ID and only listens on `127.0.0.1`.

## Development

```bash
node tests/freeproxies.mjs                 # free server list parser
node tests/check.mjs path/to/servers.txt   # parse your own server list + build a config + check site routing
```

Files:

- `extension/lib/freeproxies.js` downloads and merges the free server lists
- `extension/lib/links.js` reads share links and server list files
- `extension/lib/xray.js` builds the Xray config (one server, or a balanced pool of the fastest)
- `extension/lib/pac.js` sets which sites use the VPN
- `extension/background.js` handles connecting, speed tests and server list updates
- `helper/opengate_host.py` is the native messaging helper (no extra Python packages needed)
