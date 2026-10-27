#!/usr/bin/env bash
# ==============================================================================
# traer-token.sh — Se corre EN LA LAPTOP: trae .bridge-token del robot por SSH.
#
# Uso:
#   ./traer-token.sh [--force] <IP_DEL_ROBOT> [ruta-del-repo-en-el-robot]
#   ./traer-token.sh [--force] <usuario>@<IP_DEL_ROBOT> [ruta-del-repo-en-el-robot]
#
# Sin usuario usa ROBOT_USER (o tu usuario local). La ruta del repo en el robot es
# ~/Desktop/rosorin-jsconf por defecto (o ROBOT_REPO). Si ya tienes .bridge-token y el bridge del
# robot lo acepta, no lo vuelve a copiar (--force lo trae igual). El token llega por la salida de
# ssh (nunca en argv ni en la URL) y se guarda en .bridge-token con permisos 600.
# ==============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN_FILE="$ROOT_DIR/.bridge-token"
# shellcheck source=robot-bridge/scripts/robot-common.sh
ROSORIN_LOG_TAG="[traer-token]" source "$ROOT_DIR/robot-bridge/scripts/robot-common.sh"

FORCE=false
if [ "${1:-}" = "--force" ] || [ "${1:-}" = "-f" ]; then
  FORCE=true
  shift
fi
if [ $# -lt 1 ] || [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
  sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'
  [ $# -lt 1 ] && exit 1 || exit 0
fi

TARGET="$1"
ROBOT_REPO="${2:-${ROBOT_REPO:-~/Desktop/rosorin-jsconf}}"
if [[ "$TARGET" != *@* ]]; then
  TARGET="${ROBOT_USER:-$USER}@$TARGET"
fi
ROBOT_IP="${TARGET#*@}"

# ¿Ya está el de este robot? /status sin token responde 401 y con el token correcto 200.
if [ "$FORCE" = false ] && [ -s "$TOKEN_FILE" ]; then
  BRIDGE_TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  CODE="$(rosorin_curl_with_token -s -m 3 -o /dev/null -w '%{http_code}' "http://$ROBOT_IP:${BRIDGE_PORT:-9000}/status" || true)"
  case "$CODE" in
    200)
      echo "[traer-token] Ya tienes el token de este robot en $TOKEN_FILE (el bridge lo acepta): no lo copio de nuevo."
      exit 0
      ;;
    401) echo "[traer-token] El token de $TOKEN_FILE no es el de este robot: traigo el nuevo." ;;
    *) echo "[traer-token] Ya existe $TOKEN_FILE, pero el bridge de $ROBOT_IP no responde para verificarlo: lo comparo con el del robot." ;;
  esac
fi

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

if [ -s "$TOKEN_FILE" ] && cmp -s "$TMP_FILE" "$TOKEN_FILE"; then
  echo "[traer-token] El token del robot es el mismo que ya tenías en $TOKEN_FILE: no lo cambio."
else
  mv "$TMP_FILE" "$TOKEN_FILE"
  trap - EXIT
  echo "[traer-token] Token guardado en $TOKEN_FILE (permisos 600)."
fi
echo "[traer-token] Ahora corre:  ./run.sh --robot-ip $ROBOT_IP"
