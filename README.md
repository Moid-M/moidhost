# moidhost

Self-hosted Minecraft server manager. Single binary, zero dependencies.

## Features

- **Multiple servers** — run several Minecraft servers on one machine
- **Web UI** — dashboard, real-time console, file manager, settings
- **Drag & drop upload** — plugins, worlds, configs — just drop them in
- **Console via WebSocket** — full interactive console in your browser
- **Lightweight** — 8 MB binary, ~5 MB RAM idle, leaves resources for your servers

## Quick start

```bash
# Download and run (no install needed)
./moidhost

# Or install as a systemd service
sudo ./install.sh
```

Open `http://localhost:8080` in your browser.

## Usage

1. Click **+ New Server** and give it a name
2. Upload your server jar (e.g. `paper-1.21.1.jar`) via the **Files** tab
3. Set the jar filename in **Settings**
4. Hit **Start** on the Dashboard
5. Watch the console, send commands, upload plugins

### Configuration

The server reads `config.json` from the current directory (or `$MOIDHOST_DATA`).

| Env var | Default | Description |
|---|---|---|
| `MOIDHOST_DATA` | `.` | Directory for config.json and server data |

## Install

```bash
sudo ./install.sh
```

Installs the binary to `/usr/local/bin`, creates `/var/lib/moidhost/` for data, and sets up a systemd service.

## Update

```bash
sudo ./update.sh
```

Pulls the latest release or builds from source if no release is found.

## Uninstall

```bash
sudo ./uninstall.sh
```

Stops the service, removes the binary and (optionally) your data.

## Build from source

```bash
make build
# or
go build -o moidhost .
```

Requires Go 1.22+. No other dependencies.

## Architecture

```
                 Browser (Web UI)
                      |
                  HTTP / WS
                      |
              moidhost (Go binary)
              ├── Static files (embedded)
              ├── REST API
              ├── WebSocket console
              └── Java process manager
                      |
                  Java (Minecraft server)
```

## Why not Pterodactyl / Pelican?

- **Single binary** — no PHP, Node.js, Docker, or database server needed
- **Simple** — one config file, one data directory
- **Lightweight** — uses < 10 MB RAM when no servers are running
- **No lock-in** — your servers are standard Minecraft installations

## License

MIT
