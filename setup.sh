#!/usr/bin/env bash
# Instal·la la web de CC Mallorca al servidor (servei systemd + dades).
# Ús:  bash clients/ccmallorca/setup.sh [CONTRASENYA]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=5002
DATA_DIR=/var/www/ccmallorca-data
SERVICE_USER="${SUDO_USER:-$USER}"
NODE_BIN="$(command -v node || true)"
PASSWORD="${1:-}"

echo "==> Instal·lant la web de CC Mallorca"

if [ -z "$NODE_BIN" ]; then
  echo "ERROR: no s'ha trobat 'node' al PATH."
  exit 1
fi

sudo mkdir -p "$DATA_DIR/uploads" "$DATA_DIR/backups"
sudo chown -R "$SERVICE_USER" "$DATA_DIR"

echo "==> Creant el servei systemd (port $PORT, usuari $SERVICE_USER)"
sudo tee /etc/systemd/system/ccmallorca.service >/dev/null <<EOF
[Unit]
Description=Web de CC Mallorca (editor tipus FrontPage)
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
Environment=CCM_PORT=$PORT
Environment=CCM_DATA_DIR=$DATA_DIR
ExecStart=$NODE_BIN $HERE/server.mjs
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now ccmallorca
sleep 1

# Contrasenya d'edicio
if [ -n "$PASSWORD" ]; then
  echo "==> Establint la contrasenya d'edicio"
  CCM_DATA_DIR="$DATA_DIR" "$NODE_BIN" "$HERE/server.mjs" --set-password "$PASSWORD"
  sudo systemctl restart ccmallorca
  sleep 1
fi

sudo systemctl --no-pager --full status ccmallorca | head -8 || true

echo
echo "==> Provant el servei..."
if curl -fsS "http://127.0.0.1:$PORT/api/session" >/dev/null; then
  echo "OK: el servei respon al port $PORT"
else
  echo "ERROR: no respon. Mira: sudo journalctl -u ccmallorca -n 40"
fi

cat <<INFO

============================================================
 FALTA UN PAS: afegir la web a nginx
============================================================
Edita  /etc/nginx/sites-available/quadern-estiu  i afegeix
DINS del bloc 'server { ... }' aquestes linies:

    location = /ccmallorca { return 301 /ccmallorca/; }

    location /ccmallorca/ {
        proxy_pass http://127.0.0.1:$PORT/;
        proxy_set_header Host \$host;
        client_max_body_size 12M;
        proxy_read_timeout 60s;
    }

IMPORTANT: la linia 'client_max_body_size' es imprescindible,
si no nginx rebutjara les fotos grans.

Despres:
    sudo nginx -t && sudo systemctl reload nginx

I ja podras obrir:   http://172.20.10.17/ccmallorca/
============================================================
INFO
