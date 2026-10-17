#!/usr/bin/env bash
# Munta la web de CC Mallorca en un Ubuntu (nginx + PHP) d'una tirada,
# amb actualitzacio automatica des de GitHub cada 5 minuts.
#
# Us (com el teu usuari, no root; demanara la contrasenya de sudo):
#   sudo apt-get install -y git
#   git clone https://github.com/hidagar/ccmallorca-web.git ~/ccmallorca-web
#   bash ~/ccmallorca-web/servidor/instalar-ubuntu.sh
#
# Port: 80 per defecte. Si el 80 ja el fa servir una altra web d'aquest
# servidor (p. ex. el Quadern d'Estiu), fa servir el 8080. Per triar-ne un:
#   PORT=8081 bash ~/ccmallorca-web/servidor/instalar-ubuntu.sh
#
# Es pot tornar a executar sense por: no esborra cap foto ni cap text.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_ROOT=/var/www/ccmallorca
DATA_DIR=/var/lib/ccmallorca-data
SITE=/etc/nginx/sites-available/ccmallorca

if [ "$(id -u)" -eq 0 ]; then
  echo "Executa'l com el teu usuari (sense sudo davant); ja el demanara quan calgui."
  exit 1
fi

echo "==> 1/5 Paquets (nginx, PHP)"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git nginx php-fpm php-mbstring curl >/dev/null

PHP_SOCK="$(ls /run/php/php*-fpm.sock 2>/dev/null | head -1 || true)"
PHP_SERVICE="$(systemctl list-unit-files 'php*-fpm.service' --no-legend | awk '{print $1}' | head -1)"
sudo systemctl enable --now "$PHP_SERVICE"
[ -n "$PHP_SOCK" ] || PHP_SOCK="$(ls /run/php/php*-fpm.sock | head -1)"
echo "    PHP: $PHP_SERVICE ($PHP_SOCK)"

if [ -z "${PORT:-}" ]; then
  if ls /etc/nginx/sites-enabled/ 2>/dev/null | grep -qv '^ccmallorca$\|^default$'; then PORT=8080; else PORT=80; fi
fi

echo "==> 2/5 Carpetes"
sudo mkdir -p "$WEB_ROOT/uploads" "$DATA_DIR"
sudo chown -R www-data:www-data "$DATA_DIR" "$WEB_ROOT/uploads"
sudo chmod 750 "$DATA_DIR"

echo "==> 3/5 Copiant la web"
bash "$SCRIPT_DIR/desplegar.sh"
if [ ! -f "$WEB_ROOT/config.local.php" ]; then
  sudo tee "$WEB_ROOT/config.local.php" >/dev/null <<PHP
<?php
\$CCM = array('data_dir' => '$DATA_DIR');
PHP
fi

echo "==> 4/5 nginx (port $PORT)"
sudo tee "$SITE" >/dev/null <<NGINX
server {
    listen $PORT;
    server_name _;

    root $WEB_ROOT;
    index index.html;
    client_max_body_size 30m;

    # El mateix que fa public/.htaccess a cPanel
    location ~ (^|/)\.(user\.ini|ht) { deny all; }
    location ~ ^/(config\.local\.php|content\.default\.json)$ { deny all; }
    location ^~ /uploads/ {
        location ~ \.php$ { deny all; }
        expires 30d;
    }

    location = /api.php {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:$PHP_SOCK;
    }
    location ~ \.php$ { deny all; }

    location / { try_files \$uri \$uri/ =404; }
}
NGINX
sudo ln -sf "$SITE" /etc/nginx/sites-enabled/ccmallorca
if [ "$PORT" = 80 ]; then sudo rm -f /etc/nginx/sites-enabled/default; fi
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx

echo "==> 5/5 Actualitzacio automatica (cada 5 minuts)"
sudo tee /etc/systemd/system/ccmallorca-deploy.service >/dev/null <<UNIT
[Unit]
Description=Actualitza la web de CC Mallorca des de GitHub
After=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash $SCRIPT_DIR/desplegar.sh --si-hi-ha-canvis
UNIT
sudo tee /etc/systemd/system/ccmallorca-deploy.timer >/dev/null <<UNIT
[Unit]
Description=Comprova cada 5 minuts si hi ha canvis a la web de CC Mallorca

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now ccmallorca-deploy.timer

# La primera visita crea content.json, config.json i les contrasenyes
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api.php?r=session" || true

IP="$(hostname -I | awk '{print $1}')"
URL="http://$IP/"; [ "$PORT" = 80 ] || URL="http://$IP:$PORT/"
echo
echo "============================================================"
echo " Fet! Web de CC Mallorca:  $URL"
echo "============================================================"
if sudo test -f "$DATA_DIR/CONTRASENAS.txt"; then
  echo
  sudo cat "$DATA_DIR/CONTRASENAS.txt"
  echo
  echo "(Apuntades a $DATA_DIR/CONTRASENAS.txt; canvia-les des del modo administrador.)"
fi
