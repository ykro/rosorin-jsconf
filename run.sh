#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

WEB_PORT="${WEB_PORT:-3000}"
BRIDGE_PORT="${BRIDGE_PORT:-${PORT:-9000}}"
BRIDGE_ONLY=false
FORCE_BACKEND=""
REMOTE_ROBOT_IP="${ROBOT_IP:-}"
ASSUME_YES="${ASSUME_YES:-0}"
WEB_LAN="${WEB_LAN:-0}"
TOKEN_FILE="$ROOT_DIR/.bridge-token"

# Salvaguardas compartidas con iniciar-robot.sh (token, ESTOP_LOCK, servicios de fábrica, curl).
ROSORIN_LOG_TAG="[run.sh]"
# shellcheck source=robot-bridge/scripts/robot-common.sh
source "$ROOT_DIR/robot-bridge/scripts/robot-common.sh"

usage() {
  cat <<EOF
Uso: ./run.sh [OPCIONES]

Lanzador unificado de ROSOrin Pro · Physical AI con Gemini Live y JS.

Opciones:
  --mock                 Forzar backend mock (gemelo digital 3D, sin hardware; bridge en 127.0.0.1)
  --serial               Forzar backend serial STM32 (/dev/rrc @ 1Mbps; sin LiDAR, máx. 0.15 m/s)
  --ros2                 Forzar backend ROS 2 Humble (worker Python + LiDAR /scan)
  --bridge-only          Levantar solo el puente Rust (:9000), sin la web Next.js
  --robot-ip, --ip <IP>  Usar la web local contra el puente de un ROSOrin Pro remoto
                         (requiere BRIDGE_TOKEN o el archivo .bridge-token copiado del robot)
  --port, -p <PUERTO>    Puertos: --port 3000:9000 o --port 9000
  --web-port <PUERTO>    Puerto de la web Next.js (por defecto: 3000)
  --bridge-port <PUERTO> Puerto del puente Rust (por defecto: 9000)
  --web-lan              Exponer la web en la LAN (0.0.0.0). Por defecto solo 127.0.0.1
  --yes, -y              Instalar Rust/Node sin preguntar si faltan (también ASSUME_YES=1)
  --help, -h             Mostrar esta ayuda y salir

Variables de entorno:
  BRIDGE_TOKEN           Token del puente. En el robot se genera solo y se guarda en .bridge-token (600)
  ROBOT_BACKEND          mock | serial | ros2 (explícito: si falla, el puente no cae a mock)
  ROBOT_IP, WEB_PORT, BRIDGE_PORT, ASSUME_YES, WEB_LAN

Seguridad:
  - Con hardware (ros2/serial) o --bridge-only el puente escucha en 0.0.0.0 y exige token.
  - En --mock el puente escucha solo en 127.0.0.1.
  - La URL de la web se imprime con #token=... (fragmento: no llega al servidor ni a sus logs);
    la web lo guarda y lo quita de la barra. Los curl internos pasan el token por stdin, no en argv.
  - Si existe ~/.openclaw/workspace/ESTOP_LOCK (paro de emergencia de otra app) no arranca con hardware.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --robot-ip|--ip)
      if [[ -z "${2:-}" ]]; then
        echo "[run.sh] Error: $1 requiere una IP." >&2
        usage >&2
        exit 1
      fi
      REMOTE_ROBOT_IP="$2"
      shift 2
      ;;
    --robot-ip=*)
      REMOTE_ROBOT_IP="${1#*=}"
      shift
      ;;
    --mock)
      FORCE_BACKEND="mock"
      shift
      ;;
    --port|-p)
      if [[ -z "${2:-}" ]]; then
        echo "[run.sh] Error: $1 requiere un puerto." >&2
        usage >&2
        exit 1
      fi
      # Soporta: --port 3000:9000  o  --port 3000 9000  o  --port 9000
      if [[ "${2:-}" == *:* ]]; then
        WEB_PORT="${2%%:*}"
        BRIDGE_PORT="${2##*:}"
        shift 2
      elif [[ "${2:-}" =~ ^[0-9]+$ ]] && [[ "${3:-}" =~ ^[0-9]+$ ]]; then
        WEB_PORT="$2"
        BRIDGE_PORT="$3"
        shift 3
      else
        if [ "${2:-9000}" -lt 6000 ] 2>/dev/null; then
          WEB_PORT="$2"
        else
          BRIDGE_PORT="$2"
        fi
        shift 2
      fi
      ;;
    --web-port)
      if [[ -z "${2:-}" ]]; then
        echo "[run.sh] Error: --web-port requiere un puerto." >&2
        usage >&2
        exit 1
      fi
      WEB_PORT="$2"
      shift 2
      ;;
    --bridge-port)
      if [[ -z "${2:-}" ]]; then
        echo "[run.sh] Error: --bridge-port requiere un puerto." >&2
        usage >&2
        exit 1
      fi
      BRIDGE_PORT="$2"
      shift 2
      ;;
    --serial)
      FORCE_BACKEND="serial"
      shift
      ;;
    --ros2)
      FORCE_BACKEND="ros2"
      shift
      ;;
    --bridge-only)
      BRIDGE_ONLY=true
      shift
      ;;
    --web-lan)
      WEB_LAN=1
      shift
      ;;
    --yes|-y)
      ASSUME_YES=1
      shift
      ;;
    *)
      echo "[run.sh] Error: opción desconocida '$1'" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# Pide confirmación antes de ejecutar un instalador descargado (curl | sh).
# En modo no interactivo aborta salvo ASSUME_YES=1 / --yes.
confirm_install() {
  local what="$1" manual="$2"
  if [ "$ASSUME_YES" = "1" ]; then
    return 0
  fi
  if [ ! -t 0 ]; then
    echo "[run.sh] Falta $what y no hay terminal interactiva para confirmar la instalación." >&2
    echo "[run.sh] Instálalo a mano ($manual) o vuelve a correr con --yes / ASSUME_YES=1." >&2
    exit 1
  fi
  local answer=""
  read -r -p "[run.sh] Falta $what. ¿Descargar e instalar ahora ($manual)? [s/N] " answer
  case "$answer" in
    s|S|si|SI|sí|Sí|y|Y|yes) return 0 ;;
    *)
      echo "[run.sh] Instalación cancelada. Instálalo a mano: $manual" >&2
      exit 1
      ;;
  esac
}

# 1. Cargar entorno ROS 2 Humble + ros2_ws + mission_ws si estamos en el Jetson Orin Nano (ROSOrin Pro)
if [ -f "/opt/ros/humble/setup.bash" ]; then
  set +u
  # shellcheck disable=SC1091
  source /opt/ros/humble/setup.bash
  if [ -f "$HOME/ros2_ws/install/setup.bash" ]; then
    # shellcheck disable=SC1091
    source "$HOME/ros2_ws/install/setup.bash"
  fi
  if [ -f "$HOME/mission_ws/install/setup.bash" ]; then
    # shellcheck disable=SC1091
    source "$HOME/mission_ws/install/setup.bash"
  fi
  set -u
fi

# 2. Detectar automáticamente el backend.
#    En el ROSOrin Pro usamos 'ros2': robot-bridge/scripts/ros2_worker.py abre /dev/rrc con el SDK
#    oficial (Board) y se suscribe a /scan y /depth_cam/rgb0/image_raw. Si /dev/rrc está ocupado,
#    publica en /controller/cmd_vel, /servo_controller y /ros_robot_controller/set_buzzer.
SERIAL_DEV="/dev/ttyACM0"
if [ -e "/dev/rrc" ]; then
  SERIAL_DEV="/dev/rrc"
fi

# Un backend pedido explícitamente (flag o ROBOT_BACKEND) no cae a mock si falla;
# solo el autodetectado pasa --allow-mock-fallback.
BACKEND_AUTODETECTED=false
if [ -n "$FORCE_BACKEND" ]; then
  ROBOT_BACKEND="$FORCE_BACKEND"
elif [ -z "${ROBOT_BACKEND:-}" ]; then
  BACKEND_AUTODETECTED=true
  if [ -f "/opt/ros/humble/setup.bash" ]; then
    ROBOT_BACKEND="ros2"
  elif [ -e "$SERIAL_DEV" ]; then
    ROBOT_BACKEND="serial"
  else
    ROBOT_BACKEND="mock"
  fi
fi

# 3. Token y dirección de escucha del puente.
if [ -n "$REMOTE_ROBOT_IP" ]; then
  # Laptop → robot: el token lo generó el robot; aquí no se inventa uno nuevo.
  if [ -z "${BRIDGE_TOKEN:-}" ] && [ -s "$TOKEN_FILE" ]; then
    BRIDGE_TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  fi
  if [ -z "${BRIDGE_TOKEN:-}" ]; then
    cat >&2 <<EOF
[run.sh] Falta el token del puente del robot ($REMOTE_ROBOT_IP).
  El robot lo guarda en <repo>/.bridge-token al correr ./run.sh. Para traerlo:
    scp <usuario>@$REMOTE_ROBOT_IP:<ruta-del-repo>/.bridge-token "$TOKEN_FILE" && chmod 600 "$TOKEN_FILE"
    # o, más corto:  ./traer-token.sh <usuario>@$REMOTE_ROBOT_IP [ruta-del-repo-en-el-robot]
  o expórtalo a mano:  BRIDGE_TOKEN=<token> ./run.sh --robot-ip $REMOTE_ROBOT_IP
EOF
    exit 1
  fi
  BRIDGE_BIND_HOST=""
elif [ "$ROBOT_BACKEND" != "mock" ] || [ "$BRIDGE_ONLY" = true ]; then
  # El puente corre en el robot y debe ser alcanzable desde la laptop: 0.0.0.0 + token obligatorio.
  rosorin_ensure_bridge_token "$TOKEN_FILE"
  BRIDGE_BIND_HOST="0.0.0.0"
else
  # Mock en la laptop: solo loopback (token opcional vía BRIDGE_TOKEN).
  BRIDGE_BIND_HOST="127.0.0.1"
fi
export BRIDGE_TOKEN="${BRIDGE_TOKEN:-}"

curl_bridge() {
  # Uso: curl_bridge <ruta>  → POST con el token en header leído de stdin (nunca en la URL ni en argv)
  rosorin_curl_with_token -s -m 2 -X POST "http://${BRIDGE_HOST_TARGET}:${BRIDGE_PORT}$1"
}

# 4. En el robot físico: abortar si hay un paro de emergencia de otra app
#    (~/.openclaw/workspace/ESTOP_LOCK, nunca se borra aquí) y detener button_scan.service y
#    start_app_node.service, que acaparan /dev/rrc. Con ros2, levantar de nuevo solo el LiDAR y la
#    cámara (start_app_node los lanzaba). Ver robot-bridge/scripts/robot-common.sh.
if [ -z "$REMOTE_ROBOT_IP" ] && [ "$ROBOT_BACKEND" != "mock" ]; then
  rosorin_pause_factory_services || exit 1
  # Con start_app_node se fueron también el LiDAR y la cámara: el backend ros2 los necesita.
  if [ "$ROBOT_BACKEND" = "ros2" ]; then
    SENSOR_LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rosorin-sensores.XXXXXX")"
    rosorin_start_sensors "$SENSOR_LOG_DIR"
  fi
fi

# 5. Asegurar que cargo (Rust) esté en PATH (solo si vamos a compilar el puente aquí)
if [ -z "$REMOTE_ROBOT_IP" ]; then
  if [ -f "$HOME/.cargo/env" ]; then
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  fi
  if ! command -v cargo >/dev/null 2>&1; then
    confirm_install "Rust (cargo)" "https://rustup.rs"
    echo "[run.sh] Instalando Rust (cargo) para compilar robot-bridge..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  fi
  # Solo el binario exacto del puente (no cualquier proceso cuyo comando lo mencione)
  pkill -x rosorin-bridge 2>/dev/null || true
fi

if [ -n "$REMOTE_ROBOT_IP" ]; then
  BRIDGE_HOST_TARGET="$REMOTE_ROBOT_IP"
else
  BRIDGE_HOST_TARGET="127.0.0.1"
fi

LOCAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
if [ -z "$LOCAL_IP" ]; then
  LOCAL_IP="$(ipconfig getifaddr en0 2>/dev/null || echo 'localhost')"
fi

echo "================================================================"
echo " ROSOrin Pro · Physical AI con Gemini 3.8 Live y JS"
if [ -n "$REMOTE_ROBOT_IP" ]; then
  echo " Modo              : Laptop conectada a Robot Físico (--robot-ip $REMOTE_ROBOT_IP)"
else
  echo " Backend           : $ROBOT_BACKEND ($SERIAL_DEV)$([ "$BACKEND_AUTODETECTED" = true ] && echo ' · autodetectado')"
  echo " Bridge escucha en : ${BRIDGE_BIND_HOST}:${BRIDGE_PORT}$([ -n "$BRIDGE_TOKEN" ] && echo ' · con token')"
fi
echo "================================================================"

cleanup() {
  trap - EXIT
  echo ""
  echo "[run.sh] Deteniendo motores y cerrando puente..."
  curl_bridge "/stop" >/dev/null 2>&1 || true
  if [ -n "${BRIDGE_PID:-}" ]; then
    kill "$BRIDGE_PID" 2>/dev/null || true
  fi
  rosorin_stop_sensors
}
# Ctrl+C / SIGTERM salen del script; la salida dispara cleanup una sola vez.
trap cleanup EXIT
trap 'exit 130' INT TERM

# 6. Compilar y levantar robot-bridge en :$BRIDGE_PORT (solo si no apuntamos a un --robot-ip remoto).
#    BRIDGE_TOKEN va por entorno (no por argv) para que no aparezca en `ps`.
if [ -z "$REMOTE_ROBOT_IP" ]; then
  BRIDGE_ARGS=(--backend "$ROBOT_BACKEND" --serial-port "$SERIAL_DEV" --host "$BRIDGE_BIND_HOST" --port "$BRIDGE_PORT")
  if [ "$BACKEND_AUTODETECTED" = true ]; then
    BRIDGE_ARGS+=(--allow-mock-fallback)
  fi
  echo "[run.sh] Compilando e iniciando robot-bridge ($ROBOT_BACKEND) en ${BRIDGE_BIND_HOST}:${BRIDGE_PORT}..."
  (
    cd "$ROOT_DIR/robot-bridge"
    exec cargo run --release -- "${BRIDGE_ARGS[@]}"
  ) &
  BRIDGE_PID=$!

  if [ "$BRIDGE_ONLY" = true ]; then
    echo "[run.sh] Modo --bridge-only activo en ${BRIDGE_BIND_HOST}:${BRIDGE_PORT}. Presiona Ctrl+C para detener."
    echo "[run.sh] Desde tu laptop: copia $TOKEN_FILE y corre ./run.sh --robot-ip ${LOCAL_IP}"
    wait "$BRIDGE_PID"
    exit 0
  fi
else
  echo "[run.sh] Usando robot-bridge remoto en http://${REMOTE_ROBOT_IP}:${BRIDGE_PORT}..."
fi

# 7. Asegurar Node.js >= 22 y levantar la web app en :$WEB_PORT
export PATH="$HOME/.local/share/fnm:$HOME/.fnm:$PATH"
if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env)"
fi

NEED_NODE=false
if ! command -v node >/dev/null 2>&1; then
  NEED_NODE=true
else
  NODE_MAJOR="$(node -v | sed 's/v//' | cut -d. -f1)"
  if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
    NEED_NODE=true
  fi
fi

if [ "$NEED_NODE" = true ]; then
  confirm_install "Node.js 22 (vía fnm)" "https://github.com/Schniz/fnm"
  echo "[run.sh] Instalando Node.js 22 LTS..."
  curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell
  export PATH="$HOME/.local/share/fnm:$HOME/.fnm:$PATH"
  eval "$(fnm env)"
  fnm install 22
  fnm use 22
fi

cd "$ROOT_DIR/web"
if [ ! -d "node_modules" ]; then
  echo "[run.sh] Instalando dependencias de web (npm install)..."
  npm install
fi

# La web por defecto solo escucha en 127.0.0.1; --web-lan la expone en la LAN (opt-in).
if [ "$WEB_LAN" = "1" ]; then
  WEB_BIND_HOST="0.0.0.0"
else
  WEB_BIND_HOST="127.0.0.1"
fi

if [ -n "$REMOTE_ROBOT_IP" ]; then
  BRIDGE_PUBLIC_URL="http://${REMOTE_ROBOT_IP}:${BRIDGE_PORT}"
elif [ "$WEB_LAN" = "1" ] && [ "$ROBOT_BACKEND" != "mock" ]; then
  # Otros equipos abren la web del robot: el puente debe ser alcanzable por la IP de la LAN.
  BRIDGE_PUBLIC_URL="http://${LOCAL_IP}:${BRIDGE_PORT}"
else
  BRIDGE_PUBLIC_URL="http://localhost:${BRIDGE_PORT}"
fi
export NEXT_PUBLIC_BRIDGE_URL="$BRIDGE_PUBLIC_URL"
if [ -z "$REMOTE_ROBOT_IP" ] && [ "$ROBOT_BACKEND" != "mock" ]; then
  export NEXT_PUBLIC_LITE_MODE="1"
fi

# El token viaja una sola vez en el fragmento (#token=): el navegador no lo manda al servidor de
# Next ni queda en sus logs; la web lo guarda en localStorage y lo quita de la barra.
# Formato: http://localhost:3000/#token=<t>  ·  con robot: http://localhost:3000/?bridge=http://IP:9000#token=<t>
WEB_PATH="/"
if [ -n "$REMOTE_ROBOT_IP" ]; then
  WEB_PATH="/?bridge=${BRIDGE_PUBLIC_URL}"
fi
WEB_FRAGMENT=""
if [ -n "$BRIDGE_TOKEN" ]; then
  WEB_FRAGMENT="#token=${BRIDGE_TOKEN}"
fi

echo "================================================================"
echo " Abre esta URL (incluye el token del puente; no la proyectes):"
echo "   http://localhost:${WEB_PORT}${WEB_PATH}${WEB_FRAGMENT}"
echo " Hub Ligero (Sin 3D) : http://localhost:${WEB_PORT}/robot"
echo " Bridge Hardware     : ${BRIDGE_PUBLIC_URL}"
if [ "$WEB_LAN" = "1" ]; then
  echo " Web en la LAN       : http://${LOCAL_IP}:${WEB_PORT}/"
fi
echo "================================================================"

# Pre-compilar en segundo plano todas las rutas para que el primer clic sea instantáneo
(
  sleep 4
  for route in "/robot" "/demos/roaster?lite=1" "/demos/gatekeeper?lite=1" "/demos/bughunter?lite=1" "/demos/bumblebee?lite=1"; do
    curl -s "http://127.0.0.1:${WEB_PORT}${route}" >/dev/null 2>&1 || true
  done
  echo "[run.sh] Rutas de los 4 demos pre-compiladas y listas."
) &

npm run dev -- -H "$WEB_BIND_HOST" -p "$WEB_PORT"
