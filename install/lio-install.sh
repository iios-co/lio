#!/usr/bin/env bash

# Copyright (c) 2021-2026 community-scripts ORG
# Author: rayone
# License: MIT | https://github.com/community-scripts/DevScripts/raw/main/LICENSE
# Source: https://github.com/iios-co/lio
APP="Lio"
app="lio"

source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os
msg_info "Installing Dependencies"
$STD apt install -y curl git tar sqlite3 ca-certificates python3 python3-venv python3-pip
msg_ok "Installed Dependencies"

msg_info "Setting up Lio Service User and Directories"
if ! getent group lio >/dev/null; then
  addgroup --system lio
fi
if ! getent passwd lio >/dev/null; then
  adduser --system --ingroup lio --home /var/lib/lio --no-create-home --disabled-password --gecos "Lio Server" lio
fi
mkdir -p /var/lib/lio /etc/lio
chown -R lio:lio /var/lib/lio /etc/lio
msg_ok "Configured Directories"

msg_info "Setting up Lio Server"
if ! fetch_and_deploy_gh_release "lio" "iios-co/lio" "tarball" 2>/dev/null; then
  if [[ -d /opt/lio/.git ]]; then
    cd /opt/lio && $STD git pull
  else
    rm -rf /opt/lio
    $STD git clone https://github.com/iios-co/lio.git /opt/lio
  fi
  echo "v0.9.30" > ~/.lio
fi
python3 -m venv /opt/lio/runtime
$STD /opt/lio/runtime/bin/pip install --upgrade pip setuptools wheel
$STD /opt/lio/runtime/bin/pip install /opt/lio/lio-server
msg_ok "Set up Lio Server"

msg_info "Configuring Lio Environment"
cat <<EOF >/etc/lio/lio.env
LIO_DB_PATH=/var/lib/lio/lio.db
LIO_HOST=0.0.0.0
LIO_PORT=8000
LIO_DEADLINK_CHECK=1
LIO_DEADLINK_ALLOW_PRIVATE=0
LIO_COOKIE_SECURE=0
EOF
chmod 640 /etc/lio/lio.env
chown root:lio /etc/lio/lio.env

# Initialize database
runuser -u lio -- /opt/lio/runtime/bin/python -m lio_server --init-db --db-path /var/lib/lio/lio.db
msg_ok "Configured Environment and Database"

msg_info "Creating Systemd Service"
cat <<EOF >/etc/systemd/system/lio-server.service
[Unit]
Description=Lio - Bookmark & Tab Sync Server
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=lio
Group=lio
WorkingDirectory=/var/lib/lio
EnvironmentFile=/etc/lio/lio.env
ExecStart=/opt/lio/runtime/bin/python -m lio_server
Restart=always
RestartSec=3
LimitNOFILE=65536
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/lio /etc/lio
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable -q --now lio-server.service
msg_ok "Created and Started Service"

msg_info "Waiting for Lio Server"
for _ in {1..30}; do
  curl -fsS http://127.0.0.1:8000/healthz >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:8000/healthz >/dev/null || { msg_error "Lio server failed to start"; exit 1; }
msg_ok "Lio server is healthy"

motd_ssh
customize
cleanup_lxc
