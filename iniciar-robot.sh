#!/usr/bin/env bash
# ==============================================================================
# iniciar-robot.sh — Lanzador de 1 Clic para el Hiwonder ROSOrin Pro
# Levanta el puente Rust (:9000), la interfaz Next.js (:3000) y abre el
# Rostro Cinético (/face) a pantalla completa en la pantalla táctil de 7".
# ==============================================================================
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# 1. Cargar entorno ROS 2 Humble si estamos en el robot (Ubuntu 22.04)
if [ -f "/opt/ros/humble/setup.bash" ]; then
  set +e
  source /opt/ros/humble/setup.bash
  [ -f "$HOME/ros2_ws/install/setup.bash" ] && source "$HOME/ros2_ws/install/setup.bash"
  set -e
fi

# 2. Iniciar el puente Rust en :9000 si no está corriendo
if ! curl -s http://127.0.0.1:9000/status >/dev/null 2>&1; then
  echo "[ROSOrin] Iniciando rosorin-bridge en :9000..."
  cd "$ROOT_DIR/robot-bridge"
  BACKEND="mock"
  if [ -e "/dev/rrc" ] || [ -e "/dev/ttyACM0" ] || [ -f "/opt/ros/humble/setup.bash" ]; then
    BACKEND="ros2"
  fi
  if [ -x "./target/release/rosorin-bridge" ]; then
    nohup ./target/release/rosorin-bridge --backend "$BACKEND" --port 9000 >/tmp/rosorin-bridge.log 2>&1 &
  else
    nohup cargo run --release -- --backend "$BACKEND" --port 9000 >/tmp/rosorin-bridge.log 2>&1 &
  fi
fi

# 3. Iniciar el servidor web Next.js en :3000 si no está corriendo
if ! curl -s http://127.0.0.1:3000 >/dev/null 2>&1; then
  echo "[ROSOrin] Iniciando servidor web en :3000..."
  cd "$ROOT_DIR/web"
  nohup env NEXT_PUBLIC_LITE_MODE=1 NEXT_PUBLIC_BRIDGE_URL=http://localhost:9000 npm run dev -- -H 0.0.0.0 -p 3000 >/tmp/rosorin-web.log 2>&1 &
fi

# 4. Esperar a que http://localhost:3000/face esté listo
echo "[ROSOrin] Esperando interfaz en http://localhost:3000/face ..."
for _ in {1..30}; do
  if curl -s http://127.0.0.1:3000/face >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# 5. Abrir el Rostro Cinético (/face) en la pantalla de 7" del robot (o en Mac)
export DISPLAY="${DISPLAY:-:0}"
if [ -f "/run/user/1000/gdm/Xauthority" ]; then
  export XAUTHORITY="/run/user/1000/gdm/Xauthority"
elif [ -f "$HOME/.Xauthority" ]; then
  export XAUTHORITY="$HOME/.Xauthority"
fi
FACE_URL="http://localhost:3000/face"

if [ -x "/usr/local/bin/firefox" ]; then
  setsid /usr/local/bin/firefox --kiosk "$FACE_URL" >/tmp/firefox-face.log 2>&1 < /dev/null &
elif command -v firefox >/dev/null 2>&1; then
  setsid firefox --kiosk "$FACE_URL" >/tmp/firefox-face.log 2>&1 < /dev/null &
elif command -v chromium-browser >/dev/null 2>&1; then
  setsid chromium-browser --kiosk --app="$FACE_URL" --autoplay-policy=no-user-gesture-required >/dev/null 2>&1 < /dev/null &
elif command -v open >/dev/null 2>&1; then
  open "$FACE_URL"
fi

echo "[ROSOrin] Listo -> $FACE_URL"
