#!/usr/bin/env bash
set -euo pipefail

BINDIR="${BINDIR:-/usr/local/bin}"
DATADIR="${DATADIR:-/var/lib/moidhost}"
SERVICEDIR="${SERVICEDIR:-/etc/systemd/system}"

if [ $EUID -ne 0 ]; then
  echo "This script must be run as root (or with sudo)."
  exit 1
fi

echo "==> Uninstalling moidhost..."

# Stop and disable service
if systemctl is-active --quiet moidhost 2>/dev/null; then
  systemctl stop moidhost
  echo "  Service stopped."
fi
if systemctl is-enabled --quiet moidhost 2>/dev/null; then
  systemctl disable moidhost
  echo "  Service disabled."
fi

# Remove service file
rm -f "$SERVICEDIR/moidhost.service"
systemctl daemon-reload
echo "  Service file removed."

# Remove binary
rm -f "$BINDIR/moidhost"
echo "  Binary removed ($BINDIR/moidhost)"

# Remove data (ask first)
if [ -d "$DATADIR" ]; then
  echo ""
  echo "  Data directory ($DATADIR) still exists."
  echo "  It contains your server configs and worlds."
  read -rp "  Remove it? [y/N] " answer
  if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
    rm -rf "$DATADIR"
    echo "  Data directory removed."
  else
    echo "  Data directory kept at $DATADIR"
  fi
fi

echo ""
echo "==> Uninstall complete."
