#!/usr/bin/env bash
set -euo pipefail

if ! command -v moidhost &>/dev/null; then
  echo "moidhost is not installed. Run install.sh first."
  exit 1
fi

if [ $EUID -ne 0 ]; then
  echo "This script must be run as root (or with sudo)."
  exit 1
fi

exec moidhost update
