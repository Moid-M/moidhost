#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/moid/moidhost"
BINDIR="${BINDIR:-/usr/local/bin}"
DATADIR="${DATADIR:-/var/lib/moidhost}"

if [ $EUID -ne 0 ]; then
  echo "This script must be run as root (or with sudo)."
  exit 1
fi

echo "==> Updating moidhost..."

ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  ARCH="amd64" ;;
  aarch64) ARCH="arm64"  ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

VERSION=$(curl -sL "https://api.github.com/repos/moid/moidhost/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)
if [ -z "$VERSION" ]; then
  echo "  No release found, building from source..."
  if ! command -v go &>/dev/null; then
    echo "ERROR: Go is required. Install Go first."
    exit 1
  fi
  TMP=$(mktemp -d)
  git clone --depth=1 "$REPO" "$TMP"
  cd "$TMP"
  go build -o moidhost .
  systemctl stop moidhost 2>/dev/null || true
  cp moidhost "$BINDIR/moidhost"
  rm -rf "$TMP"
  systemctl start moidhost 2>/dev/null || true
  echo "  Updated from source."
else
  echo "  Downloading $VERSION..."
  URL="https://github.com/moid/moidhost/releases/download/$VERSION/moidhost-linux-$ARCH"
  systemctl stop moidhost 2>/dev/null || true
  curl -sL "$URL" -o "$BINDIR/moidhost"
  chmod +x "$BINDIR/moidhost"
  systemctl start moidhost 2>/dev/null || true
  echo "  Updated to $VERSION."
fi

echo "==> Update complete."
