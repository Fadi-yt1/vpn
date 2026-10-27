# OpenGate VPN — free browser VPN extension

A free VPN extension for Chrome, Edge, Brave, Vivaldi and other Chromium browsers.

- **Free servers you choose.** Import any VLESS / VMess / Trojan / Shadowsocks server list (for example a `.txt` file such as AetrisVPN's), a link to a server list, or plain HTTP/SOCKS proxies.
- **Fast servers automatically.** "Test speed" makes a real request through every server and sorts them fastest first. **Auto** mode spreads traffic over the fastest working servers and switches automatically when one slows down or dies (Xray's `leastPing` balancer).
- **Targeted website mode.** Choose **"Only my site list"** and only those sites (and their subdomains) go through the VPN, so only they see a different IP. Everything else keeps your normal, fast connection. There are one-click presets for YouTube, Instagram, X, Discord, Telegram Web, ChatGPT and more, plus an "Add the site in this tab" button.
- **Full mode.** Choose **"All sites"** to send all browser traffic through the VPN.
- **No paid plans, ever.** No accounts, sign-ups, ads or tracking. Your lists and settings stay in your browser.

## How it works

Browsers can only connect through plain HTTP/SOCKS proxies. Modern VPN servers (VLESS + Reality, xhttp, gRPC…) need **Xray-core**, the engine used by v2rayN, Hiddify and similar apps. So OpenGate has two parts:

| Part | What it does |
|------|--------------|
| `extension/` | The browser extension: server list, speed test, site list, sets the browser proxy. |
| `helper/` | A small script that the extension uses to start and stop Xray-core on your computer, and to run speed tests. You install it once. |

```
browser ──(only your sites, or everything)──► Xray on 127.0.0.1:10808 ──► fastest VPN server ──► website
```

Plain `http://`, `https://` and `socks5://` proxies work without the helper.

## Install (about 2 minutes)

### 1. Load the extension

1. Download this repository (Code → Download ZIP) and unzip it.
2. Open `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `extension` folder.

The extension ID is always `aekgcagkmfabhjpmnhaaepiljnnhmcbp`, which the helper uses to trust it.

### 2. Install the helper (one time)

You need Python 3. macOS and Linux usually have it already. On Windows, run `winget install Python.Python.3.12` first.

**Windows:** double-click `helper\install_windows.bat`
(or run `powershell -ExecutionPolicy Bypass -File helper\install_windows.ps1`)

**macOS / Linux:**
```bash
bash helper/install.sh
```

The installer downloads the latest official Xray-core from [github.com/XTLS/Xray-core](https://github.com/XTLS/Xray-core/releases) into `~/.opengate-vpn/` and registers the helper with your browsers. To remove everything later, run it with `--uninstall` (`-Uninstall` on Windows).

### 3. Add servers and connect

1. Click the OpenGate icon → **Servers** → **Add servers**.
2. Import your server file (for example `AetrisVPN.txt`), paste links, or add a link to a server list. Linked lists refresh every hour.
3. Click **Test speed of all servers**.
4. Go to **Home**, choose **All sites** or **Only my site list**, and press the power button.
5. Press **Check my IP** to confirm it works.

## Unblocking specific sites (targeted mode)

1. Go to **Sites** and add domains, such as `youtube.com`, or click a Quick add preset.
2. On **Home**, choose **Only my site list** and connect.
3. While browsing, open the popup and click **Use VPN here** to add the current site.

Only those sites change IP. Your bank, local sites and everything else stay on your normal connection.

Tip: some sites load videos or images from other domains, for example YouTube uses `googlevideo.com`. If a site only half-loads, add its CDN domains too. The presets already include them.

## Tips

- **Pick a server outside your country** to unblock sites blocked there. Use Settings → *Auto mode: country*, or pick a server by hand in the Servers list.
- Servers in some free lists change often. If things stop working, run the speed test again. Linked server lists refresh on their own.
- Already using v2rayN, Hiddify, Nekoray or sing-box? Tick **"I run Xray… myself"** in Settings, set the same local SOCKS port, and OpenGate will only handle the per-site routing.
- **Download Xray config** exports a ready-to-run config for your chosen servers.

## Privacy and safety

- Your traffic is only as private as the server you use. Free public servers are run by strangers, so use HTTPS sites and avoid sensitive logins over servers you don't trust.
- In targeted mode, only the listed sites use the VPN, which is by design.
- The helper only accepts commands from this extension's ID and only listens on `127.0.0.1`.

## Development

```bash
node tests/check.mjs path/to/servers.txt   # parse a server list + build a config + check site routing
```

Files:

- `extension/lib/links.js` reads share links and server list files
- `extension/lib/xray.js` builds the Xray config (one server, or a balanced pool of the fastest)
- `extension/lib/pac.js` sets which sites use the VPN
- `extension/background.js` handles connecting, speed tests and server list updates
- `helper/opengate_host.py` is the native messaging helper (no extra Python packages needed)
