#!/usr/bin/env bash
# Copia la web (public/ + content.default.json) a la carpeta que serveix
# nginx. No toca mai les fotos pujades (uploads/) ni les dades del client.
# Us manual:     bash servidor/desplegar.sh
# Us automatic:  bash servidor/desplegar.sh --si-hi-ha-canvis
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_ROOT="${CCM_WEB_ROOT:-/var/www/ccmallorca}"
OWNER="$(stat -c %U "$REPO_DIR")"

as_owner() {
  if [ "$(id -un)" = "$OWNER" ]; then bash -c "$1"; else runuser -u "$OWNER" -- bash -c "$1"; fi
}
as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

cd "$REPO_DIR"
BEFORE="$(as_owner "git -C '$REPO_DIR' rev-parse HEAD")"
as_owner "cd '$REPO_DIR' && git pull -q origin main"
AFTER="$(as_owner "git -C '$REPO_DIR' rev-parse HEAD")"

if [ "$BEFORE" = "$AFTER" ] && [ "${1:-}" = "--si-hi-ha-canvis" ]; then
  exit 0
fi

as_root mkdir -p "$WEB_ROOT/uploads"
as_root cp -R "$REPO_DIR/public/." "$WEB_ROOT/"
as_root cp "$REPO_DIR/content.default.json" "$WEB_ROOT/"
as_root chown -R www-data:www-data "$WEB_ROOT/uploads"

echo "Desplegat: $(as_owner "git -C '$REPO_DIR' log -1 --format='%h %s'")"
