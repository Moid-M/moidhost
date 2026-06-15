#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/moid/moidhost"
BINDIR="${BINDIR:-/usr/local/bin}"
DATADIR="${DATADIR:-/var/lib/moidhost}"
SERVICEDIR="${SERVICEDIR:-/etc/systemd/system}"

if [ $EUID -ne 0 ]; then
  echo "This script must be run as root (or with sudo)."
  exit 1
fi

echo "==> Installing moidhost..."

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  ARCH="amd64" ;;
  aarch64) ARCH="arm64"  ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

# Determine latest version
echo "  Fetching latest release..."
VERSION=$(curl -sL "https://api.github.com/repos/moid/moidhost/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)
if [ -z "$VERSION" ]; then
  echo "  Could not determine latest version. Building from source..."
  if ! command -v go &>/dev/null; then
    echo "ERROR: Go is required to build from source. Install Go first."
    exit 1
  fi
  TMP=$(mktemp -d)
  git clone --depth=1 "$REPO" "$TMP"
  cd "$TMP"
  go build -o moidhost .
  cp moidhost "$BINDIR/moidhost"
  rm -rf "$TMP"
else
  echo "  Downloading $VERSION..."
  URL="https://github.com/moid/moidhost/releases/download/$VERSION/moidhost-linux-$ARCH"
  curl -sL "$URL" -o "$BINDIR/moidhost"
  chmod +x "$BINDIR/moidhost"
fi

echo "  Binary installed to $BINDIR/moidhost"

# Create data directory
mkdir -p "$DATADIR"
echo "  Data directory: $DATADIR"

# Install systemd service
cat > "$SERVICEDIR/moidhost.service" <<UNIT
[Unit]
Description=moidhost - Minecraft server manager
After=network.target

[Service]
Type=simple
ExecStart=$BINDIR/moidhost
Environment=MOIDHOST_DATA=$DATADIR
Restart=on-failure
RestartSec=5
User=nobody
Group=nogroup

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
echo "  Systemd service installed (moidhost.service)"

echo ""
echo "==> Installation complete!"
echo ""
echo "  Start:  sudo systemctl start moidhost"
echo "  Status: sudo systemctl status moidhost"
echo "  Enable: sudo systemctl enable moidhost"
echo "  Logs:   sudo journalctl -u moidhost -f"
echo "  Config: $DATADIR/config.json"
echo ""
echo "  Open http://localhost:8080 once the service is running."
