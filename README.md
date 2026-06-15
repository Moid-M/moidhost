<div align="center">
  <br>
  <h1 align="center">🟣 moidhost</h1>
  <p align="center">
    <strong>Your Minecraft servers. One binary. Zero fuss.</strong>
    <br>
    A self-hosted Minecraft server manager with a web UI.
    <br>
    Run multiple servers. Manage from any browser. No Docker, no PHP, no database.
    <br>
    <strong>🔒 No telemetry. No tracking. Everything stays yours.</strong>
  </p>
  <p align="center">
    <a href="#-quick-install">🚀 Quick Install</a>
    ·
    <a href="#-features">✨ Features</a>
    ·
    <a href="#-commands">⚙️ Commands</a>
    ·
    <a href="#-architecture">🏗️ Architecture</a>
    ·
    <a href="#-development">🛠️ Development</a>
  </p>
  <p align="center">
    <img src="https://img.shields.io/badge/go-1.23%2B-blue?style=flat-square&logo=go">
    <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square">
    <img src="https://img.shields.io/badge/version-0.1-purple?style=flat-square">
    <img src="https://img.shields.io/badge/status-beta-brightgreen?style=flat-square">
  </p>
  <br>
</div>

---

## ✨ Features

<table>
<tr>
<td width="50%">

**🎮 Multi-Server** — run several Minecraft servers on one machine, each with independent settings

**🖥️ Web Dashboard** — start, stop, restart, kill any server with one click

**📟 Real-Time Console** — interactive WebSocket terminal in your browser — send commands, watch output live

**📂 File Manager** — browse, upload (drag & drop), download, rename, delete, and edit files right in the browser

**🌍 World Management** — download, upload (zip), replace, or delete worlds. Right-click to navigate to Files

</td>
<td width="50%">

**💾 Backups** — select folders (worlds/plugins/mods/datapacks), create zip backups, restore or download them

**👤 Player Stats** — view known players, play time, distance walked, kills, deaths, K/D ratio from world stats

**📊 System Graphs** — live CPU, RAM, and disk usage with bezier-curve canvas graphs and hover tooltips

**🔐 Authentication** — login with username/password, per-user permissions per server (dashboard/console/files/world/backups/players/settings)

**📱 Mobile Responsive** — collapsible sidebar, bottom-sheet context menu, touch-friendly controls

</td>
</tr>
</table>

---

## 🚀 Quick Install

<details>
<summary><b>One-liner (Linux with systemd)</b></summary>
<br>

```bash
curl -fsSL https://raw.githubusercontent.com/Moid-M/moidhost/main/install.sh | sudo bash
```

<details>
<summary><b>📦 What the installer does</b></summary>
<br>

| Step | What happens |
|---|---|
| 1 | Detects your distro and installs Go + Java if missing |
| 2 | Creates a `moidhost` system user |
| 3 | Builds the binary and installs to `/usr/local/bin` |
| 4 | Creates data directory at `/var/lib/moidhost` |
| 5 | **Prompts for admin username and password** |
| 6 | Installs a systemd service |
| 7 | Starts the server immediately |

</details>

> **After install**, open **http://your-server-ip:8080** in any browser and log in with the admin account you created.

> **moidhost is built with AI-assisted coding.** Most of the code was written through natural language prompts. If something feels off, please [open an issue](https://github.com/Moid-M/moidhost/issues).

</details>

<details>
<summary><b>🖥️ Build from source</b></summary>
<br>

```bash
git clone https://github.com/Moid-M/moidhost.git
cd moidhost
go build -o moidhost .
sudo ./moidhost
```

Requires Go 1.22+. Java must be installed separately for Minecraft servers to run. Then open **http://localhost:8080**.

</details>

---

## ⚙️ Commands

### CLI (`moidhost`)

After install, the `moidhost` CLI is available globally:

<details>
<summary><b>⚙️ CLI commands (click to expand)</b></summary>
<br>

```bash
moidhost                    Start the web server
moidhost version            Print version
sudo moidhost update        Self-update (rebuilds from source)
sudo moidhost uninstall     Remove binary, service, and data
sudo moidhost reset-password  Reset admin password
```

</details>

<details>
<summary><b>🛠️ Service management (click to expand)</b></summary>
<br>

| Action | Command |
|---|---|
| ▶️ Start | `sudo systemctl start moidhost` |
| ⏹️ Stop | `sudo systemctl stop moidhost` |
| 🔄 Restart | `sudo systemctl restart moidhost` |
| 📊 Status | `sudo systemctl status moidhost` |
| 📜 Logs | `journalctl -u moidhost.service -f` |
| 🔄 Update | `sudo moidhost update` |
| 🗑️ Uninstall | `sudo moidhost uninstall` |
| 🔑 Reset password | `sudo moidhost reset-password` |

</details>

---

## 🔧 Configuration

<details>
<summary><b>Click to expand</b></summary>
<br>

All configuration is via environment variables:

| Variable | Default | Description |
|---|---|---|
| `MOIDHOST_DATA` | `/var/lib/moidhost` | Directory for config.json, users.json, and per-server data |
| `MOIDHOST_ADDR` | `:8080` | Listen address (e.g. `:80` or `0.0.0.0:443`) |

### Data layout

```
$MOIDHOST_DATA/
├── config.json              # Global server manager config
├── users.json               # User accounts (bcrypt hashes, roles, permissions)
├── .setup_admin             # Deleted after first-run admin creation
└── servers/
    └── <server-id>/
        ├── server.properties
        ├── eula.txt
        ├── world/
        ├── world_nether/
        ├── world_the_end/
        ├── backups/
        ├── plugins/
        ├── usercache.json
        └── ...              # Your server jar, configs, mods
```

> [!NOTE]
> Change `MOIDHOST_DATA` and restart with `sudo systemctl restart moidhost` to use a different data directory.

</details>

---

## 🏗️ Architecture

```
                  Browser (Web UI)
                       |
                   HTTP / WS
                       |
               moidhost (Go binary)
               ├── Embedded web files (vanilla HTML/CSS/JS)
               ├── REST API (auth, servers, files, world, backups, users)
               ├── WebSocket console server
               ├── JSON config store (no database)
               └── Java process manager (PTY-based)
                       |
                   Java (Minecraft server)
```

### Design decisions

- **Single binary** — everything embedded, including all web assets. No Node.js, no PHP, no Docker.
- **No database** — config and user data stored as plain JSON files. Zero daemons to manage.
- **Raw process management** — no container overhead. Starts Java directly with a PTY for interactive console.
- **Vanilla frontend** — no React, no Vue, no build step. One HTML file, one CSS file, one JS file.
- **Authentication** — bcrypt password hashing, random 32-byte session tokens, 24h expiry, per-server permission model.

---

## 🧩 Tech Stack

| Layer | Technology |
|---|---|
| **Backend** | Go 1.23+ (standard library + `github.com/coder/websocket` + `golang.org/x/crypto`) |
| **Frontend** | Vanilla JavaScript (no framework, no build step) |
| **Database** | JSON files (users via read/write with `sync.RWMutex`) |
| **Process** | PTY-based Java subprocess with ring buffer log |
| **Console** | WebSocket with bidirectional command I/O |

---

## 📊 Resource Usage

moidhost is designed for modest hardware — it runs comfortably alongside your Minecraft servers on a **$5 VPS** or **Raspberry Pi**.

| Resource | Idle | Active (1 server) |
|---|---|---|
| **Binary size** | ~10 MB | — |
| **RAM** | ~5 MB | ~8 MB (moidhost only; Java server RAM is separate) |
| **CPU** | < 0.5% | 1–3% (API requests, console streaming) |

Your Minecraft server's resource usage depends on its own configuration (Xmx, plugins, player count).

---

## 📄 License

This project is **open source** — you are free to use, modify, share, sell, or do absolutely anything you want with it. No strings attached.

[MIT](LICENSE)

---

<div align="center">
  <p>Made with ❤️ + 🤖 for people who love Minecraft.</p>
  <p>
    <a href="https://github.com/Moid-M/moidhost/issues">🐛 Report a bug</a>
    ·
    <a href="https://github.com/Moid-M/moidhost/issues">💡 Request a feature</a>
  </p>
</div>
