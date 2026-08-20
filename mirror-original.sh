#!/usr/bin/env bash
# Descarrega una copia de la web original (ccmallorca.net) per poder
# traslladar-ne els textos, les seccions i l'inventari de fotos.
#
# Ús:
#   bash clients/ccmallorca/mirror-original.sh           # nomes HTML (lleuger)
#   bash clients/ccmallorca/mirror-original.sh --fotos   # HTML + imatges
#
# Despres puja el resultat al repositori:
#   git add clients/ccmallorca/original && git commit -m "copia de la web original" && git push
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HERE/original"
SITE=https://www.ccmallorca.net/
WITH_PHOTOS="${1:-}"

if ! command -v wget >/dev/null; then
  echo "Cal instal·lar wget:  sudo apt install -y wget"
  exit 1
fi

# Si ja hi ha pagines de veritat (per exemple pujades a ma perque la
# descarrega automatica no arribava a ccmallorca.net), no les esborrem
# sense mes: les guardem en una copia de seguretat abans d'intentar-ho.
if [ -d "$DEST" ] && find "$DEST" -maxdepth 1 -iname '*.htm*' -print -quit | grep -q .; then
  BACKUP="$HERE/original.abans-de-mirror.$(date +%s)"
  echo "==> Ja hi havia contingut a original/; en fem copia a $(basename "$BACKUP")"
  cp -r "$DEST" "$BACKUP"
fi

mkdir -p "$DEST"

COMMON=(
  --mirror
  --page-requisites
  --convert-links
  --adjust-extension
  --no-parent
  --restrict-file-names=windows
  --directory-prefix="$DEST"
  --no-host-directories
  --timeout=25
  --tries=3
  --wait=0.3
  --user-agent="Mozilla/5.0 (compatible; copia-de-seguretat)"
)

echo "==> Descarregant $SITE"
if [ "$WITH_PHOTOS" = "--fotos" ]; then
  wget "${COMMON[@]}" "$SITE" || true
else
  # Sense imatges: la copia queda lleugera per pujar-la al repositori
  wget "${COMMON[@]}" --reject "jpg,jpeg,png,gif,bmp,webp,pdf,zip,mp4,avi" "$SITE" || true
fi

echo
echo "==> Pagines descarregades:"
find "$DEST" -type f \( -name '*.htm*' \) | sed "s|$DEST/||" | sort | head -60
echo "    total: $(find "$DEST" -type f -name '*.htm*' | wc -l) pagines"

# Inventari de fotos referenciades (encara que no s'hagin baixat)
echo "==> Fent l'inventari de fotos referenciades..."
grep -rhoiE 'src="[^"]+\.(jpg|jpeg|png|gif|webp)"' "$DEST" 2>/dev/null \
  | sed -E 's/^src="//; s/"$//' | sort -u > "$DEST/inventari-fotos.txt" || true
echo "    $(wc -l < "$DEST/inventari-fotos.txt" 2>/dev/null || echo 0) fotos referenciades (a original/inventari-fotos.txt)"

echo "==> Mida de la copia: $(du -sh "$DEST" | cut -f1)"

cat <<'INFO'

============================================================
 Copia feta a clients/ccmallorca/original/
 Puja-la al repositori perque es pugui fer servir el contingut real:

     cd ~/sebastia
     git add clients/ccmallorca/original
     git commit -m "copia de la web original de ccmallorca"
     git push -u origin claude/cool-tesla-jn22yt
============================================================
INFO
