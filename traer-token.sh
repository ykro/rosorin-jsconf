#!/usr/bin/env bash
# ==============================================================================
# traer-token.sh — Se corre EN LA LAPTOP: trae .bridge-token del robot por SSH.
#
# Uso:
#   ./traer-token.sh <IP_DEL_ROBOT> [ruta-del-repo-en-el-robot]
#   ./traer-token.sh <usuario>@<IP_DEL_ROBOT> [ruta-del-repo-en-el-robot]
#
# Sin usuario usa ROBOT_USER (o tu usuario local). La ruta del repo en el robot es
# ~/Desktop/rosorin-jsconf por defecto (o ROBOT_REPO). El token llega por la salida de ssh
# (nunca en argv ni en la URL) y se guarda en .bridge-token con permisos 600.
# ==============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN_FILE="$ROOT_DIR/.bridge-token"

if [ $# -lt 1 ] || [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
  sed -n '3,11p' "$0" | sed 's/^# \{0,1\}//'
  [ $# -lt 1 ] && exit 1 || exit 0
fi

TARGET="$1"
ROBOT_REPO="${2:-${ROBOT_REPO:-~/Desktop/rosorin-jsconf}}"
if [[ "$TARGET" != *@* ]]; then
  TARGET="${ROBOT_USER:-$USER}@$TARGET"
fi
ROBOT_IP="${TARGET#*@}"

TMP_FILE="$(mktemp "$ROOT_DIR/.bridge-token.XXXXXX")"
chmod 600 "$TMP_FILE"
trap 'rm -f "$TMP_FILE"' EXIT

if ! ssh -o ConnectTimeout=5 "$TARGET" "cat $ROBOT_REPO/.bridge-token" > "$TMP_FILE"; then
  echo "[traer-token] No pude leer $ROBOT_REPO/.bridge-token en $TARGET." >&2
  echo "[traer-token] Revisa la IP y el usuario, y que el bridge se haya levantado en el robot con 'make robot' (genera el token)." >&2
  exit 1
fi
if [ ! -s "$TMP_FILE" ]; then
  echo "[traer-token] El token del robot está vacío. Corre 'make robot' en el robot y vuelve a intentar." >&2
  exit 1
fi

mv "$TMP_FILE" "$TOKEN_FILE"
trap - EXIT
echo "[traer-token] Token guardado en $TOKEN_FILE (permisos 600)."
echo "[traer-token] Ahora corre:  ./run.sh --robot-ip $ROBOT_IP"
