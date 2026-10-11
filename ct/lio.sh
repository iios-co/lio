#!/usr/bin/env bash
_CS_DEFAULT_URL="https://raw.githubusercontent.com/iios-co/lio/main"
export COMMUNITY_SCRIPTS_URL="${COMMUNITY_SCRIPTS_URL:-https://raw.githubusercontent.com/iios-co/lio/main}"
_cs_boot="${COMMUNITY_SCRIPTS_CORE_DIR:-$(dirname "${BASH_SOURCE[0]}")/../../core}/core/build.func"
source "$_cs_boot" 2>/dev/null || source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL:-https://raw.githubusercontent.com/community-scripts/core/main}/core/build.func")

# Copyright (c) 2021-2026 community-scripts ORG
# Author: rayone
# License: MIT | https://github.com/community-scripts/DevScripts/raw/main/LICENSE
# Source: https://github.com/iios-co/lio

APP="Lio"
var_tags="${var_tags:-sync;bookmarks;tabs;productivity}"
var_cpu="${var_cpu:-2}"
var_ram="${var_ram:-1024}"
var_disk="${var_disk:-4}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
var_unprivileged="${var_unprivileged:-1}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources

  if [[ ! -d /opt/lio ]]; then
    msg_error "No ${APP} Installation Found!"
    exit 1
  fi
  # Migrate legacy runtime layout before clean install wipes /opt/lio
  if [[ ! -d /opt/lio-runtime ]] && [[ -d /opt/lio/runtime ]] && [[ ! -L /opt/lio/runtime ]]; then
    msg_info "Migrating runtime directory to /opt/lio-runtime"
    mv /opt/lio/runtime /opt/lio-runtime
    ln -sfn /opt/lio-runtime /opt/lio/runtime
  fi

  if check_for_gh_release "lio" "iios-co/lio"; then
    msg_info "Stopping Lio Service"
    systemctl stop lio-server
    msg_ok "Stopped Lio Service"

    update_succeeded=0
    had_lio_marker=0
    [[ -f ~/.lio ]] && { had_lio_marker=1; cp -a ~/.lio ~/.lio.old 2>/dev/null || true; }
    cp -a /etc/lio/lio.env /etc/lio/lio.env.old 2>/dev/null || true
    cleanup_update() {
      if [[ "$update_succeeded" -ne 1 ]]; then
        msg_info "Attempting recovery: restoring previous runtime, environment, and version marker"
        if [[ -d /opt/lio-runtime.old ]]; then
          rm -rf /opt/lio-runtime
          mv /opt/lio-runtime.old /opt/lio-runtime
          ln -sfn /opt/lio-runtime /opt/lio/runtime
        fi
        if [[ -f /etc/lio/lio.env.old ]]; then
          mv -f /etc/lio/lio.env.old /etc/lio/lio.env
        fi
        if [[ "$had_lio_marker" -eq 1 ]] && [[ -f ~/.lio.old ]]; then
          mv -f ~/.lio.old ~/.lio
        else
          rm -f ~/.lio
        fi
        systemctl daemon-reload
        systemctl restart lio-server 2>/dev/null || true
      fi
    }
    trap cleanup_update EXIT

    CLEAN_INSTALL=1 fetch_and_deploy_gh_release "lio" "iios-co/lio" "tarball"
    ln -sfn /opt/lio-runtime /opt/lio/runtime

    RELEASE_TAG=$(cat ~/.lio 2>/dev/null || true)
    FULL_SHA=""
    if [[ -n "$RELEASE_TAG" ]]; then
      FULL_SHA=$(git ls-remote https://github.com/iios-co/lio.git "refs/tags/${RELEASE_TAG}^{}" "refs/tags/${RELEASE_TAG}" 2>/dev/null | awk -v tag="$RELEASE_TAG" '$2 == "refs/tags/"tag"^{}" {print $1; found=1; exit} $2 == "refs/tags/"tag {fallback=$1} END {if (!found) print fallback}')
    fi
    [[ "$FULL_SHA" =~ ^[0-9a-f]{40}$ ]] || { msg_error "Could not resolve valid 40-hex commit SHA from GitHub"; exit 1; }
    [ -n "$RELEASE_TAG" ] || { msg_error "Could not resolve release tag from GitHub"; exit 1; }
    RELEASE_SHA="${FULL_SHA:0:12}"

    # Build new runtime in isolated location
    rm -rf /opt/lio-runtime.new
    python3 -m venv /opt/lio-runtime.new
    $STD /opt/lio-runtime.new/bin/pip install --upgrade pip setuptools wheel
    $STD env SETUPTOOLS_SCM_PRETEND_VERSION_FOR_LIO_SERVER="${RELEASE_TAG#v}" /opt/lio-runtime.new/bin/pip install --upgrade /opt/lio/lio-server

    # Validate new runtime can import cleanly
    /opt/lio-runtime.new/bin/python -c "import lio_server" || { msg_error "Failed to verify new Lio runtime"; exit 1; }

    # Backup existing env before swap
    cp -a /etc/lio/lio.env /etc/lio/lio.env.old 2>/dev/null || true

    # Atomically swap runtime
    rm -rf /opt/lio-runtime.old
    [[ -d /opt/lio-runtime ]] && mv /opt/lio-runtime /opt/lio-runtime.old
    mv /opt/lio-runtime.new /opt/lio-runtime
    ln -sfn /opt/lio-runtime /opt/lio/runtime

    # Atomically upsert environment file
    tmp_env=$(mktemp /etc/lio/.env.XXXXXX 2>/dev/null || mktemp /tmp/.env.XXXXXX)
    grep -v '^LIO_RELEASE_' /etc/lio/lio.env > "$tmp_env" 2>/dev/null || true
    echo "LIO_RELEASE_VERSION=${RELEASE_TAG}" >> "$tmp_env"
    echo "LIO_RELEASE_SHA=${RELEASE_SHA}" >> "$tmp_env"
    chmod 640 "$tmp_env"
    chown root:lio "$tmp_env" 2>/dev/null || true
    mv -f "$tmp_env" /etc/lio/lio.env

    msg_info "Starting Lio Service"
    systemctl daemon-reload
    systemctl restart lio-server
    msg_ok "Started Lio Service"

    msg_info "Verifying Lio Health and Version"
    HEALTH_OK=0
    for _ in {1..20}; do
      if curl -fsS http://127.0.0.1:8000/healthz >/dev/null 2>&1; then
        HEALTH_OK=1
        break
      fi
      sleep 1
    done
    [[ "$HEALTH_OK" -eq 1 ]] || { msg_error "Lio health check failed after update"; exit 1; }

    # Verify version endpoint matches the deployed release
    EXPECTED_VER="${RELEASE_TAG#v}"
    REPORTED_VER=$(curl -fsS http://127.0.0.1:8000/version 2>/dev/null | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p')
    REPORTED_SHA=$(curl -fsS http://127.0.0.1:8000/version 2>/dev/null | sed -n 's/.*"sha": *"\([^"]*\)".*/\1/p')
    if [[ "$REPORTED_VER" != "$EXPECTED_VER" ]] || [[ "$REPORTED_SHA" != "$RELEASE_SHA" ]]; then
      msg_error "Version mismatch after update: expected ${EXPECTED_VER} (${RELEASE_SHA}), got ${REPORTED_VER} (${REPORTED_SHA})"
      exit 1
    fi

    update_succeeded=1
    rm -rf /opt/lio-runtime.old /etc/lio/lio.env.old ~/.lio.old
    trap - EXIT
    msg_ok "Lio is healthy (v${EXPECTED_VER} - ${RELEASE_SHA})"
    msg_ok "Updated successfully!"
  else
    msg_ok "Lio is already up to date"
  fi
  exit 0
}

start
build_container
description

msg_ok "Completed Successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW}Access Web Console and Sync Server using the following URL:${CL}"
echo -e "${GATEWAY}${BGN}http://${IP}:8000${CL}"
