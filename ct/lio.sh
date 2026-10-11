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
    exit
  fi

  if check_for_gh_release "lio" "iios-co/lio"; then
    msg_info "Stopping Lio Service"
    systemctl stop lio-server
    msg_ok "Stopped Lio Service"

    cleanup_update() {
      if ! systemctl is-active --quiet lio-server; then
        msg_info "Attempting recovery: restarting Lio Service"
        systemctl start lio-server 2>/dev/null || true
      fi
    }
    trap cleanup_update EXIT

    CLEAN_INSTALL=1 fetch_and_deploy_gh_release "lio" "iios-co/lio" "tarball"
    python3 -m venv /opt/lio/runtime
    $STD /opt/lio/runtime/bin/pip install --upgrade pip setuptools wheel
    $STD /opt/lio/runtime/bin/pip install /opt/lio/lio-server

    msg_info "Starting Lio Service"
    systemctl daemon-reload
    systemctl restart lio-server
    msg_ok "Started Lio Service"

    msg_info "Verifying Lio Health"
    for _ in {1..20}; do
      curl -fsS http://127.0.0.1:8000/healthz >/dev/null 2>&1 && break
      sleep 1
    done
    curl -fsS http://127.0.0.1:8000/healthz >/dev/null || { msg_error "Lio health check failed after update"; exit 1; }
    trap - EXIT
    msg_ok "Lio is healthy"
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
