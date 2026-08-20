#!/usr/bin/env bash
# Instal·la la web de CC Mallorca de dalt a baix, en una sola ordre:
#   1. servei systemd + carpeta de dades
#   2. contrasenya d'edicio
#   3. copia de la web original (ccmallorca.net) amb les fotos
#   4. importacio del contingut real
#   5. configuracio d'nginx (amb validacio i marxa enrere si falla)
#   6. comprovacio final
#
# Us:  bash clients/ccmallorca/instalar-todo.sh [CONTRASENYA]
#      bash clients/ccmallorca/instalar-todo.sh [CONTRASENYA] --sin-contenido
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=5002
DATA_DIR=/var/www/ccmallorca-data
SERVICE_USER="${SUDO_USER:-$USER}"
NODE_BIN="$(command -v node || true)"
PASSWORD="${1:-mallorca}"
SKIP_CONTENT="${2:-}"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[33m    %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m    %s\033[0m\n' "$1"; }

[ -n "$NODE_BIN" ] || { echo "ERROR: no s'ha trobat 'node'."; exit 1; }

# ---------------------------------------------------------- 1. servei i dades

step "1/6 · Preparant la carpeta de dades"
sudo mkdir -p "$DATA_DIR/uploads" "$DATA_DIR/backups"
sudo chown -R "$SERVICE_USER" "$DATA_DIR"
ok "$DATA_DIR"

step "2/6 · Creant el servei (port $PORT, usuari $SERVICE_USER)"
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
sudo systemctl enable --now ccmallorca >/dev/null 2>&1 || sudo systemctl enable --now ccmallorca
sleep 1
ok "servei ccmallorca actiu"

step "3/6 · Establint la contrasenya d'edicio"
CCM_DATA_DIR="$DATA_DIR" "$NODE_BIN" "$HERE/server.mjs" --set-password "$PASSWORD" >/dev/null
ok "contrasenya: $PASSWORD"

# ------------------------------------------------- 4. contingut real de la web

if [ "$SKIP_CONTENT" = "--sin-contenido" ]; then
  step "4/6 · Contingut real (omes per peticio)"
  warn "es fara servir el contingut d'exemple"
else
  step "4/6 · Descarregant la web original i important-ne el contingut"
  if ! command -v wget >/dev/null; then
    warn "wget no esta instal·lat; instal·lant-lo..."
    sudo apt-get install -y wget >/dev/null 2>&1 || warn "no s'ha pogut instal·lar wget"
  fi

  if command -v wget >/dev/null && bash "$HERE/mirror-original.sh" --fotos; then
    if CCM_DATA_DIR="$DATA_DIR" "$NODE_BIN" "$HERE/import-original.mjs"; then
      ok "contingut real importat"
      # Informe del disseny original (colors, tipografies, maquetacio).
      # Serveix per reproduir el format exacte.
      "$NODE_BIN" "$HERE/analizar-diseno.mjs" || true
      "$NODE_BIN" "$HERE/analizar-diseno.mjs" --json >/dev/null 2>&1 || true
    else
      warn "no s'ha pogut importar el contingut; es queda el d'exemple"
    fi
  else
    warn "no s'ha pogut descarregar ccmallorca.net; es queda el contingut d'exemple"
  fi
  sudo chown -R "$SERVICE_USER" "$DATA_DIR"
  sudo systemctl restart ccmallorca
  sleep 1
fi

# ------------------------------------------------------------- 5. nginx

step "5/6 · Configurant nginx"
NGINX_OUT="$(sudo "$NODE_BIN" "$HERE/patch-nginx.mjs" || true)"
echo "$NGINX_OUT" | sed 's/^/    /'
BACKUP="$(echo "$NGINX_OUT" | tail -n1)"

if sudo nginx -t >/dev/null 2>&1; then
  sudo systemctl reload nginx
  ok "nginx recarregat correctament"
else
  warn "la configuracio d'nginx no valida! Desfent el canvi..."
  if [ -f "$BACKUP" ]; then
    sudo cp "$BACKUP" "${BACKUP%%.abans-de-ccmallorca.*}"
    sudo nginx -t && sudo systemctl reload nginx
    warn "s'ha restaurat la configuracio anterior. Revisa-ho a ma."
  fi
  sudo nginx -t 2>&1 | tail -5
fi

# ------------------------------------------------------------ 6. comprovacio

step "6/6 · Comprovant que tot respon"
FAIL=0
if curl -fsS "http://127.0.0.1:$PORT/api/session" >/dev/null; then
  ok "el servei respon al port $PORT"
else
  warn "el servei NO respon. Mira: sudo journalctl -u ccmallorca -n 40"; FAIL=1
fi

if curl -fsS "http://127.0.0.1/ccmallorca/" -o /dev/null; then
  ok "la web respon a traves d'nginx"
else
  warn "nginx no serveix /ccmallorca/ encara"; FAIL=1
fi

SECCIONS="$($NODE_BIN -e "try{const c=require('$DATA_DIR/content.json');console.log(Object.keys(c.pages).length)}catch(e){console.log('?')}" 2>/dev/null || echo '?')"
FOTOS="$(ls -1 "$DATA_DIR/uploads" 2>/dev/null | wc -l)"

printf '\n============================================================\n'
if [ "$FAIL" = "0" ]; then
  printf ' LLEST. Obre:  http://172.20.10.17/ccmallorca/\n'
else
  printf ' Acabat amb avisos. Revisa els missatges de dalt.\n'
fi
printf '============================================================\n'
printf ' Seccions:    %s\n' "$SECCIONS"
printf ' Fotos:       %s\n' "$FOTOS"
printf ' Contrasenya: %s\n' "$PASSWORD"
printf '\n Per editar: obre la web, baixa al peu i pulsa "Editar la web".\n'
printf ' Registres:  sudo journalctl -u ccmallorca -n 40\n'
printf '============================================================\n'
