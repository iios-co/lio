#!/usr/bin/env bash
# Local bundle installer for lio-server.
# Invoked with: install.sh [BUNDLE_DIR] [VERSION]
set -euo pipefail

BUNDLE_DIR="${1:-$PWD}"
VERSION="${2:-$(date -u +%Y%m%d%H%M%S)}"
INSTALL_ROOT="${INSTALL_ROOT:-/opt/lio}"
SERVICE_USER="${SERVICE_USER:-lio}"
STATE_DIR="${STATE_DIR:-/var/lib/lio}"
CONFIG_DIR="${CONFIG_DIR:-/etc/lio}"

[ "$(id -u)" -eq 0 ] || { echo "error: run as root" >&2; exit 1; }

# 1. Create service user if needed
if ! getent group "$SERVICE_USER" >/dev/null; then
  addgroup --system "$SERVICE_USER"
fi
if ! getent passwd "$SERVICE_USER" >/dev/null; then
  adduser --system --ingroup "$SERVICE_USER" --home "$STATE_DIR" \
    --no-create-home --disabled-password --gecos "Lio Server" "$SERVICE_USER"
fi

# 2. Prepare directories
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$STATE_DIR"
install -d -o root -g "$SERVICE_USER" -m 0750 "$CONFIG_DIR"
install -d -o root -g root -m 0755 "$INSTALL_ROOT/releases"

# 3. Copy bundle into release directory
TARGET="$INSTALL_ROOT/releases/$VERSION"
rm -rf "$TARGET"
mkdir -p "$TARGET"
cp -a "$BUNDLE_DIR/." "$TARGET/"

# 4. Atomically point current to the new release
ln -sfn "releases/$VERSION" "$INSTALL_ROOT/current"

# 5. Build database from schema if missing
DB_PATH="$STATE_DIR/lio.db"
if [ ! -f "$DB_PATH" ]; then
  echo "Initializing database from schema..."
  runuser -u "$SERVICE_USER" -- \
    "$INSTALL_ROOT/current/runtime/bin/python" -m lio_server --init-db --db-path "$DB_PATH"
  shopt -s nullglob
  chown "$SERVICE_USER:$SERVICE_USER" "$DB_PATH" "$DB_PATH"-wal "$DB_PATH"-shm 2>/dev/null || chown "$SERVICE_USER:$SERVICE_USER" "$DB_PATH"
fi

# 6. Install systemd unit
if [ -f "$TARGET/systemd/lio-server.service" ]; then
  cp "$TARGET/systemd/lio-server.service" /etc/systemd/system/lio-server.service
elif [ -f "$TARGET/lio-server.service" ]; then
  cp "$TARGET/lio-server.service" /etc/systemd/system/lio-server.service
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl enable --now lio-server.service
  echo "lio-server.service installed and started."
fi
