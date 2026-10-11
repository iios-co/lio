#!/usr/bin/env bash
# Single-command installer for Lio Server on a Debian/Ubuntu VPC or container.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/iios-co/lio/main/lio-server/deploy/debian-install.sh -o /tmp/lio-install.sh && sudo bash /tmp/lio-install.sh && rm -f /tmp/lio-install.sh
#
# Or from a local clone:
#   sudo bash lio-server/deploy/debian-install.sh
set -euo pipefail

REPO_URL=${REPO_URL:-https://github.com/iios-co/lio.git}
REPO_REF=${REPO_REF:-main}
PYTHON_VERSION=${PYTHON_VERSION:-3.12.8}
SERVICE_USER=${SERVICE_USER:-lio}
STATE_DIR=${STATE_DIR:-/var/lib/lio}
CONFIG_DIR=${CONFIG_DIR:-/etc/lio}
INSTALL_ROOT=${INSTALL_ROOT:-/opt/lio}
LIO_PORT=${LIO_PORT:-8787}
LIO_HOST=${LIO_HOST:-0.0.0.0}

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# --- 1. Preflight checks ---------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "this script must be run as root (or with sudo)"
command -v systemctl >/dev/null || die "systemd is required"
[ -r /etc/os-release ] || die "cannot identify the distribution"

OS_ID=$(. /etc/os-release && printf '%s' "${ID:-}")
case $OS_ID in
  debian|ubuntu) ;;
  *) die "expected a Debian or Ubuntu system, found '${OS_ID:-unknown}'" ;;
esac

log "installing system prerequisites"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl git tar sqlite3 python3 python3-venv >/dev/null 2>&1 || \
  apt-get install -y -qq --no-install-recommends ca-certificates curl git tar sqlite3 >/dev/null

# --- 2. Locate or fetch source --------------------------------------------
WORK=$(mktemp -d)
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# Check if run directly from a local repository checkout
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../pyproject.toml" ]; then
  SRC="$(cd "$SCRIPT_DIR/.." && pwd)"
  log "using local source at $SRC"
  REVISION="local"
elif [ -f "$PWD/lio-server/pyproject.toml" ]; then
  SRC="$PWD/lio-server"
  log "using local source at $SRC"
  REVISION="local"
elif [ -f "$PWD/pyproject.toml" ]; then
  SRC="$PWD"
  log "using local source at $SRC"
  REVISION="local"
else
  log "cloning $REPO_URL ($REPO_REF)"
  git -c credential.helper= clone --quiet --depth 1 --branch "$REPO_REF" "$REPO_URL" "$WORK/src"
  if [ -d "$WORK/src/lio-server" ]; then
    SRC="$WORK/src/lio-server"
  else
    SRC="$WORK/src"
  fi
  REVISION=$(git -C "$WORK/src" rev-parse --short=7 HEAD 2>/dev/null || echo "git")
fi

BASE_VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' "$SRC/pyproject.toml" | head -n 1)
[ -n "$BASE_VERSION" ] || BASE_VERSION="0.9.0"
VERSION="${BASE_VERSION}-$(date -u +%Y%m%d%H%M%S)"
log "building release $VERSION"

# Build Web UI if node/npm are present and web-ui source exists
if [ -d "$SRC/../web-ui" ] && command -v npm >/dev/null 2>&1; then
  log "building Web UI assets"
  ( cd "$SRC/../web-ui" && npm install --silent && npm run build )
fi

# Ensure web_dist exists
if [ ! -f "$SRC/lio_server/web_dist/index.html" ]; then
  log "note: pre-built Web UI not found in $SRC/lio_server/web_dist; only API will be available"
fi

# --- 3. Python Runtime ----------------------------------------------------
SYS_PY=""
if command -v python3 >/dev/null 2>&1; then
  SYS_GE_312=$(python3 -c 'import sys; print("yes" if sys.version_info >= (3, 12) else "no")' 2>/dev/null || echo "no")
  if [ "$SYS_GE_312" = "yes" ]; then
    SYS_PY="$(command -v python3)"
    SYS_VER=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")' 2>/dev/null || echo "default")
    log "using Debian default python3 ($SYS_VER) at $SYS_PY"
  fi
fi

RELEASE_DIR="$INSTALL_ROOT/releases/$VERSION"
mkdir -p "$RELEASE_DIR"

if [ -n "$SYS_PY" ]; then
  log "creating runtime environment with Debian default python3"
  "$SYS_PY" -m venv "$RELEASE_DIR/runtime" || die "failed to create venv from Debian default python3"
  PY="$RELEASE_DIR/runtime/bin/python3"
  [ -x "$PY" ] || PY="$RELEASE_DIR/runtime/bin/python"
  [ -x "$PY" ] || die "python binary not found in $RELEASE_DIR/runtime"
  SITE=$("$PY" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')
  export PIP_ROOT_USER_ACTION=ignore PIP_DISABLE_PIP_VERSION_CHECK=1
  log "installing application dependencies"
  "$PY" -m pip install --quiet --upgrade pip setuptools wheel 2>/dev/null || true
  "$PY" -m pip install --quiet \
    "fastapi>=0.115.0,<1.0.0" "uvicorn[standard]>=0.30.0" "pydantic>=2.8.0" "fractional-indexing>=0.1.0" "httpx>=0.27.0" "hatchling"
else
  DOWNLOAD_VERSION="$PYTHON_VERSION"
  log "Debian default python3 is absent or < 3.12; downloading standalone Python $DOWNLOAD_VERSION"
  UV_VERSION="0.4.20"
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64)
      UV_TAR="uv-x86_64-unknown-linux-gnu.tar.gz"
      UV_SHA="2283626b627f33382338b7621e5b1c8df5432c5deff9e64e217ff33652beb7f0"
      ;;
    aarch64|arm64)
      UV_TAR="uv-aarch64-unknown-linux-gnu.tar.gz"
      UV_SHA="e7b173900e155210aebf205a3041ba8f896febb05d4863ba6390a3cb79c5a722"
      ;;
    *)
      die "unsupported architecture $ARCH"
      ;;
  esac
  mkdir -p "$WORK/uv"
  curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${UV_TAR}" -o "$WORK/${UV_TAR}" || die "failed to download uv"
  echo "${UV_SHA}  $WORK/${UV_TAR}" | sha256sum -c - || die "uv checksum verification failed"
  tar -xzf "$WORK/${UV_TAR}" -C "$WORK/uv" --strip-components=1 || die "failed to extract uv"
  UV=$WORK/uv/uv
  [ -x "$UV" ] || die "uv did not install"

  export UV_PYTHON_INSTALL_DIR=$WORK/pythons
  "$UV" python install --quiet "$DOWNLOAD_VERSION"
  RUNTIME_SRC=$(dirname "$(dirname "$("$UV" python find --managed-python --no-project "$DOWNLOAD_VERSION")")")
  [ -x "$RUNTIME_SRC/bin/python3" ] || die "no standalone runtime found under $RUNTIME_SRC"

  mkdir -p "$RELEASE_DIR/runtime"
  cp -a "$RUNTIME_SRC/." "$RELEASE_DIR/runtime/"
  find "$RELEASE_DIR/runtime" -name EXTERNALLY-MANAGED -delete
  PY="$RELEASE_DIR/runtime/bin/python3"
  SITE=$("$PY" -c 'import sysconfig,sys; sys.stdout.write(sysconfig.get_paths()["purelib"])')

  export PIP_ROOT_USER_ACTION=ignore PIP_DISABLE_PIP_VERSION_CHECK=1
  log "installing application dependencies"
  "$PY" -m pip install --quiet --target "$SITE" \
    "fastapi>=0.115.0,<1.0.0" "uvicorn[standard]>=0.30.0" "pydantic>=2.8.0" "fractional-indexing>=0.1.0" "httpx>=0.27.0" "hatchling"
fi
log "building and installing lio-server package"
"$PY" -m pip wheel --quiet --no-deps --wheel-dir "$WORK/wheel" "$SRC"
WHEEL=$(find "$WORK/wheel" -name 'lio_server-*.whl' -type f | head -n 1)
[ -n "$WHEEL" ] || die "the lio-server wheel did not build"
"$PY" -m pip install --quiet --no-deps --upgrade --target "$SITE" "$WHEEL"

printf '%s\n' "$REVISION" > "$RELEASE_DIR/BUILD"
find "$RELEASE_DIR" -name '__pycache__' -type d -prune -exec rm -rf {} +
find "$RELEASE_DIR" -name '*.pyc' -delete

# --- 4. Service user and state directories --------------------------------
if ! getent group "$SERVICE_USER" >/dev/null; then
  log "creating group $SERVICE_USER"
  addgroup --system "$SERVICE_USER"
fi
if ! getent passwd "$SERVICE_USER" >/dev/null; then
  log "creating user $SERVICE_USER"
  adduser --system --ingroup "$SERVICE_USER" --home "$STATE_DIR" \
    --no-create-home --disabled-password --gecos "Lio Server" "$SERVICE_USER"
fi

install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$STATE_DIR"
install -d -o root -g "$SERVICE_USER" -m 0750 "$CONFIG_DIR"
install -d -o root -g root -m 0755 "$INSTALL_ROOT"

# Switch current symlink atomically
ln -sfn "releases/$VERSION" "$INSTALL_ROOT/current"

# --- 5. Database initialization from schema -------------------------------
DB_PATH="$STATE_DIR/lio.db"
log "initializing database from schema"
runuser -u "$SERVICE_USER" -- \
  "$INSTALL_ROOT/current/runtime/bin/python" -m lio_server --init-db --db-path "$DB_PATH"
[ -f "$DB_PATH" ] || die "database file $DB_PATH was not created"
chown "$SERVICE_USER:$SERVICE_USER" "$DB_PATH"*

# --- 6. Environment & credentials configuration ---------------------------
ENV_FILE="$CONFIG_DIR/lio.env"
RANDOM_SECRET=$(head -c 32 /dev/urandom | xxd -p 2>/dev/null || python3 -c 'import secrets; print(secrets.token_hex(32))')

if [ ! -f "$ENV_FILE" ]; then
  log "generating configuration in $ENV_FILE"
  cat > "$ENV_FILE" <<EOF
LIO_HOST=${LIO_HOST}
LIO_PORT=${LIO_PORT}
LIO_DB_PATH=${DB_PATH}
LIO_SESSION_SECRET=${RANDOM_SECRET}
LIO_DEADLINK_CHECK=1
LIO_DEADLINK_ALLOW_PRIVATE=0
EOF
  chmod 0640 "$ENV_FILE"
  chown root:"$SERVICE_USER" "$ENV_FILE"
fi

# Configure admin credentials
ADMIN_PASS=${LIO_ADMIN_PASSWORD:-}
if [ -z "$ADMIN_PASS" ]; then
  # Check if admin already configured in DB
  ADMIN_CONFIGURED=$(runuser -u "$SERVICE_USER" -- \
    "$INSTALL_ROOT/current/runtime/bin/python" -c "
import sqlite3
conn = sqlite3.connect('$DB_PATH')
row = conn.execute(\"SELECT value FROM app_settings WHERE key = 'admin_password_hash'\").fetchone()
print('yes' if row else 'no')
" 2>/dev/null || echo "no")

  if [ "$ADMIN_CONFIGURED" != "yes" ]; then
    if [ -t 0 ]; then
      printf '\n\033[1;33mSet initial admin password (min 8 chars):\033[0m '
      read -r -s ADMIN_PASS
      printf '\n'
    fi
    if [ -z "$ADMIN_PASS" ] || [ ${#ADMIN_PASS} -lt 8 ]; then
      ADMIN_PASS=$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')
      printf '%s\n' "$ADMIN_PASS" > "$CONFIG_DIR/initial-admin-password"
      chmod 0600 "$CONFIG_DIR/initial-admin-password"
      chown root:"$SERVICE_USER" "$CONFIG_DIR/initial-admin-password" 2>/dev/null || true
      log "stored generated admin password in $CONFIG_DIR/initial-admin-password (read and remove)"
    fi
    printf '%s\n' "$ADMIN_PASS" | runuser -u "$SERVICE_USER" -- \
      "$INSTALL_ROOT/current/runtime/bin/python" -m lio_server --set-admin-stdin admin --db-path "$DB_PATH" || die "failed to set admin password"
  fi
else
  printf '%s\n' "$ADMIN_PASS" | runuser -u "$SERVICE_USER" -- \
    "$INSTALL_ROOT/current/runtime/bin/python" -m lio_server --set-admin-stdin admin --db-path "$DB_PATH" || die "failed to set admin password"
fi

# --- 7. Install and start systemd service ---------------------------------
log "configuring systemd service"
cp "$SRC/deploy/lio-server.service" /etc/systemd/system/lio-server.service
systemctl daemon-reload
systemctl enable lio-server.service
systemctl restart lio-server.service

sleep 2
if systemctl is-active --quiet lio-server.service; then
  log "lio-server is active and running"
else
  systemctl status lio-server.service --no-pager || true
  die "lio-server.service failed to start. View logs with: journalctl -u lio-server.service -n 50"
fi

# Verify HTTP readiness
HEALTH_OK=no
for _ in $(seq 1 10); do
  if [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${LIO_PORT}/healthz")" = "200" ]; then
    HEALTH_OK=yes
    break
  fi
  sleep 1
done

[ "$HEALTH_OK" = "yes" ] || die "health check failed at http://127.0.0.1:${LIO_PORT}/healthz"

# Prune older releases, keeping the 3 most recent
mkdir -p "$INSTALL_ROOT/releases"
(
  cd "$INSTALL_ROOT/releases"
  find . -mindepth 1 -maxdepth 1 -printf '%T@ %p\0' 2>/dev/null | sort -zrn | tail -zn +4 | cut -zd' ' -f2- | xargs -0 -r rm -rf 2>/dev/null || true
)

SERVER_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7}' | head -n 1 || echo "YOUR_SERVER_IP")

cat <<REPORT

=============================================================================
  Lio Server $VERSION has been successfully installed!
=============================================================================

  Web Console:   http://${SERVER_IP}:${LIO_PORT}/
  Local Health:  http://127.0.0.1:${LIO_PORT}/healthz
  Service:       systemctl status lio-server
  Service Logs:  journalctl -u lio-server -f
  Database:      $DB_PATH
  Config File:   $ENV_FILE

  Default Admin: admin
  Password:      ${ADMIN_PASS:+(saved in $CONFIG_DIR/initial-admin-password)}

  Create collection:
    runuser -u $SERVICE_USER -- $INSTALL_ROOT/current/runtime/bin/python -m lio_server --create-collection "My Collection" --db-path $DB_PATH

=============================================================================
REPORT
