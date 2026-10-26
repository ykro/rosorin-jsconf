#!/usr/bin/env bash
# ==============================================================================
# iniciar-robot.sh — Lanzador de 1 Clic para el Hiwonder ROSOrin Pro
# Levanta el puente Rust (:9000), la interfaz Next.js (:3000) y abre el
# Rostro Cinético (/face) a pantalla completa en la pantalla táctil de 7".
# Variables: BRIDGE_TOKEN (si no, se lee/genera en .bridge-token),
#            WEB_HOST (por defecto 127.0.0.1; 0.0.0.0 para exponer la web en la LAN)
# Mismas salvaguardas que run.sh (robot-bridge/scripts/robot-common.sh): en el robot aborta si
# existe ~/.openclaw/workspace/ESTOP_LOCK y libera /dev/rrc antes de arrancar el puente.
# ==============================================================================
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

TOKEN_FILE="$ROOT_DIR/.bridge-token"
WEB_HOST="${WEB_HOST:-127.0.0.1}"

ROSORIN_LOG_TAG="[ROSOrin]"
# shellcheck source=robot-bridge/scripts/robot-common.sh
source "$ROOT_DIR/robot-bridge/scripts/robot-common.sh"

# ¿Estamos en el robot físico? (mismo criterio que la autodetección de run.sh)
ON_ROBOT=false
if [ -e "/dev/rrc" ] || [ -e "/dev/ttyACM0" ] || [ -f "/opt/ros/humble/setup.bash" ]; then
  ON_ROBOT=true
fi

# 0. Paro de emergencia de otra app: no arrancar nada (ni abrir el rostro) hasta que se libere.
if [ "$ON_ROBOT" = true ]; then
  rosorin_check_estop_lock || exit 1
fi

LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rosorin.XXXXXX")"

# 1. Cargar entorno ROS 2 Humble si estamos en el robot (Ubuntu 22.04)
if [ -f "/opt/ros/humble/setup.bash" ]; then
  set +e
  # shellcheck disable=SC1091
  source /opt/ros/humble/setup.bash
  # shellcheck disable=SC1091
  [ -f "$HOME/ros2_ws/install/setup.bash" ] && source "$HOME/ros2_ws/install/setup.bash"
  set -e
fi

# 2. Token del puente: entorno, .bridge-token o uno nuevo (permisos 600)
rosorin_ensure_bridge_token "$TOKEN_FILE"
export BRIDGE_TOKEN

# 3. Iniciar el puente Rust en :9000 si no está corriendo (/health es público)
if ! curl -s -m 2 http://127.0.0.1:9000/health >/dev/null 2>&1; then
  echo "[ROSOrin] Iniciando rosorin-bridge en :9000 (logs en $LOG_DIR)..."
  cd "$ROOT_DIR/robot-bridge"
  BACKEND="mock"
  BRIDGE_HOST="127.0.0.1"
  if [ "$ON_ROBOT" = true ]; then
    # En el robot el puente debe ser alcanzable desde la laptop: 0.0.0.0 con token obligatorio
    BACKEND="ros2"
    BRIDGE_HOST="0.0.0.0"
    # Igual que run.sh: re-revisa ESTOP_LOCK y libera /dev/rrc de los servicios de fábrica
    rosorin_pause_factory_services || exit 1
  fi
  if [ -x "./target/release/rosorin-bridge" ]; then
    nohup ./target/release/rosorin-bridge --backend "$BACKEND" --host "$BRIDGE_HOST" --port 9000 --allow-mock-fallback >"$LOG_DIR/rosorin-bridge.log" 2>&1 &
  else
    nohup cargo run --release -- --backend "$BACKEND" --host "$BRIDGE_HOST" --port 9000 --allow-mock-fallback >"$LOG_DIR/rosorin-bridge.log" 2>&1 &
  fi
fi

# 4. Iniciar el servidor web Next.js en :3000 si no está corriendo
if ! curl -s -m 2 http://127.0.0.1:3000 >/dev/null 2>&1; then
  echo "[ROSOrin] Iniciando servidor web en ${WEB_HOST}:3000..."
  cd "$ROOT_DIR/web"
  nohup env NEXT_PUBLIC_LITE_MODE=1 NEXT_PUBLIC_BRIDGE_URL=http://localhost:9000 npm run dev -- -H "$WEB_HOST" -p 3000 >"$LOG_DIR/rosorin-web.log" 2>&1 &
fi

# 5. Esperar a que http://localhost:3000/face esté listo
echo "[ROSOrin] Esperando interfaz en http://localhost:3000/face ..."
for _ in {1..30}; do
  if curl -s http://127.0.0.1:3000/face >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# 6. Abrir el Rostro Cinético (/face) en la pantalla de 7" del robot (o en Mac).
#    El token va una sola vez en el fragmento (#token=), que no llega al servidor ni a sus logs:
#    la web lo guarda y lo quita de la barra.
export DISPLAY="${DISPLAY:-:0}"
if [ -f "/run/user/1000/gdm/Xauthority" ]; then
  export XAUTHORITY="/run/user/1000/gdm/Xauthority"
elif [ -f "$HOME/.Xauthority" ]; then
  export XAUTHORITY="$HOME/.Xauthority"
fi
FACE_URL="http://localhost:3000/face"
FACE_URL_WITH_TOKEN="${FACE_URL}#token=${BRIDGE_TOKEN}"

if [ -x "/usr/local/bin/firefox" ]; then
  setsid /usr/local/bin/firefox --kiosk "$FACE_URL_WITH_TOKEN" >"$LOG_DIR/firefox-face.log" 2>&1 < /dev/null &
elif command -v firefox >/dev/null 2>&1; then
  setsid firefox --kiosk "$FACE_URL_WITH_TOKEN" >"$LOG_DIR/firefox-face.log" 2>&1 < /dev/null &
elif command -v chromium-browser >/dev/null 2>&1; then
  setsid chromium-browser --kiosk --app="$FACE_URL_WITH_TOKEN" --autoplay-policy=no-user-gesture-required >/dev/null 2>&1 < /dev/null &
elif command -v open >/dev/null 2>&1; then
  open "$FACE_URL_WITH_TOKEN"
fi

echo "[ROSOrin] Listo -> $FACE_URL (logs en $LOG_DIR)"
