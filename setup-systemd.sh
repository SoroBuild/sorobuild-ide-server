#!/usr/bin/env bash
set -euo pipefail
APP_DIR="${1:?Usage: sudo ./setup-systemd.sh /absolute/path/to/API}"
[[ "$EUID" -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
[[ "$APP_DIR" = /* && "$APP_DIR" != *'"'* && "$APP_DIR" != *'%'* && "$APP_DIR" != *$'\n'* ]] || { echo 'Invalid absolute path.' >&2; exit 1; }
cd "$APP_DIR"
DOCKER_BIN="$(command -v docker)"
"$DOCKER_BIN" compose config --quiet
cat > /etc/systemd/system/sorobuild-ide-server.service <<SERVICE
[Unit]
Description=Sorobuild IDE API
Requires=docker.service
After=docker.service network-online.target
[Service]
Type=simple
WorkingDirectory="$APP_DIR"
ExecStart=$DOCKER_BIN compose up --no-build
ExecStop=$DOCKER_BIN compose stop -t 650
Restart=on-failure
RestartSec=5
TimeoutStopSec=670
[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
echo 'Service installed. Review configuration, then explicitly enable/start sorobuild-ide-server.service.'
