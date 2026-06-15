#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/Moid-M/moidhost"
BINDIR="${BINDIR:-/usr/local/bin}"
DATADIR="${DATADIR:-/var/lib/moidhost}"
SERVICEDIR="${SERVICEDIR:-/etc/systemd/system}"

if [ $EUID -ne 0 ]; then
  echo "This script must be run as root (or with sudo)."
  exit 1
fi

echo "==> Installing moidhost..."

ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  ARCH="amd64" ;;
  aarch64) ARCH="arm64"  ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

# Auto-install Go if missing
if ! command -v go &>/dev/null; then
  echo "  Go not found. Installing Go..."
  case "$ARCH" in
    amd64) GOARCH="amd64" ;;
    arm64) GOARCH="arm64" ;;
  esac
  GOVER="1.23.4"
  curl -sL "https://go.dev/dl/go$GOVER.linux-$GOARCH.tar.gz" -o /tmp/go.tar.gz
  rm -rf /usr/local/go
  tar -C /usr/local -xzf /tmp/go.tar.gz
  rm /tmp/go.tar.gz
  ln -sf /usr/local/go/bin/go /usr/local/bin/go
  echo "  Go $GOVER installed."
fi

echo "  Building from source..."
TMP=$(mktemp -d)
git clone --depth=1 "$REPO" "$TMP" 2>/dev/null || {
  echo "  git not available, fetching source archive instead..."
  curl -sL "https://github.com/Moid-M/moidhost/archive/refs/heads/main.tar.gz" -o /tmp/moidhost-src.tar.gz
  tar -C "$TMP" --strip-components=1 -xzf /tmp/moidhost-src.tar.gz
  rm /tmp/moidhost-src.tar.gz
}
cd "$TMP"
go build -o moidhost .
cp moidhost "$BINDIR/moidhost"
chmod +x "$BINDIR/moidhost"
rm -rf "$TMP"

echo "  Binary installed to $BINDIR/moidhost"

# Create dedicated user
if ! id -u moidhost &>/dev/null; then
  useradd --system --user-group --home-dir "$DATADIR" --shell /usr/sbin/nologin moidhost
  echo "  System user 'moidhost' created."
fi

# Create and chown data directory
mkdir -p "$DATADIR/servers"
chown -R moidhost:moidhost "$DATADIR"
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
User=moidhost
Group=moidhost

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
echo "  Systemd service installed (moidhost.service)"

# Auto-install Java if missing
if ! command -v java &>/dev/null; then
  echo ""
  echo "==> Java not found. Installing OpenJDK 21..."
  if command -v apt-get &>/dev/null; then
    apt-get update -qq
    apt-get install -y -qq openjdk-21-jre-headless
  elif command -v dnf &>/dev/null; then
    dnf install -y -q java-21-openjdk-headless
  elif command -v yum &>/dev/null; then
    yum install -y -q java-21-openjdk-headless
  elif command -v pacman &>/dev/null; then
    pacman -S --noconfirm jre21-openjdk-headless
  elif command -v apk &>/dev/null; then
    apk add openjdk21-jre-headless
  else
    echo "  WARNING: Could not detect package manager. Install Java manually."
    echo "  Debian/Ubuntu: sudo apt-get install openjdk-21-jre-headless"
  fi
  echo "  Java installed."
else
  echo "  Java found: $(java -version 2>&1 | head -1)"
fi

# Admin account setup
echo ""
echo "==> Admin Account Setup"
echo "  Create the admin account for the web interface."
read -r -p "  Username [admin]: " ADMIN_USER
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS=""
while true; do
  read -r -s -p "  Password: " ADMIN_PASS
  echo
  if [ -z "$ADMIN_PASS" ]; then
    echo "  Password cannot be empty."
    continue
  fi
  read -r -s -p "  Confirm: " ADMIN_PASS2
  echo
  if [ "$ADMIN_PASS" != "$ADMIN_PASS2" ]; then
    echo "  Passwords do not match. Try again."
    continue
  fi
  break
done
mkdir -p "$DATADIR"
cat > "$DATADIR/.setup_admin" <<EOF
{"username":"$ADMIN_USER","password":"$ADMIN_PASS"}
EOF
chmod 600 "$DATADIR/.setup_admin"
chown moidhost:moidhost "$DATADIR/.setup_admin"
echo "  Admin account will be created on first start."

echo ""
echo "==> Installation complete!"
echo ""
echo "  Start:  sudo systemctl start moidhost"
echo "  Status: sudo systemctl status moidhost"
echo "  Enable: sudo systemctl enable moidhost"
echo "  Logs:   sudo journalctl -u moidhost -f"
echo ""
echo "  CLI commands:"
echo "    moidhost                    Start the web server"
echo "    moidhost version            Print version"
echo "    sudo moidhost update        Self-update"
echo "    sudo moidhost uninstall     Remove everything"
echo "    sudo moidhost reset-password  Reset admin password"
echo ""
echo "  Open http://localhost:8080 once the service is running."
