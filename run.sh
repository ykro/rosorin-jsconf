#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

WEB_PORT="${WEB_PORT:-3000}"
BRIDGE_PORT="${BRIDGE_PORT:-${PORT:-9000}}"
BRIDGE_ONLY=false
FORCE_BACKEND=""
REMOTE_ROBOT_IP="${ROBOT_IP:-}"

usage() {
  cat <<EOF
Usage: ./run.sh [OPTIONS]

Unified launcher for ROSOrin Pro · Embodied AI with Gemini Live & JS.

Options:
  --mock                 Force Mock backend (3D Digital Twin only, no hardware required)
  --serial               Force direct STM32 serial backend (/dev/rrc @ 1Mbps)
  --ros2                 Force ROS 2 Humble / Python hardware worker backend
  --bridge-only          Launch only the Rust robot-bridge (:9000) without Next.js web UI
  --robot-ip, --ip <IP>  Connect local Next.js web UI to a remote ROSOrin Pro bridge IP
  --port, -p <PORT>      Set port(s): e.g. --port 3000:9000 or --port 9000
  --web-port <PORT>      Set Next.js web server port (default: 3000)
  --bridge-port <PORT>   Set Rust robot-bridge port (default: 9000)
  --help, -h             Show this help message and exit
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
        echo "[run.sh] Error: $1 requires an IP address argument." >&2
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
        echo "[run.sh] Error: $1 requires a port argument." >&2
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
        echo "[run.sh] Error: --web-port requires a port argument." >&2
        usage >&2
        exit 1
      fi
      WEB_PORT="$2"
      shift 2
      ;;
    --bridge-port)
      if [[ -z "${2:-}" ]]; then
        echo "[run.sh] Error: --bridge-port requires a port argument." >&2
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
    *)
      echo "[run.sh] Error: Unknown option '$1'" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# 1. Cargar entorno ROS 2 Humble + ros2_ws + mission_ws si estamos en el Jetson Orin Nano (ROSOrin Pro)
if [ -f "/opt/ros/humble/setup.bash" ]; then
  set +u
  source /opt/ros/humble/setup.bash
  if [ -f "$HOME/ros2_ws/install/setup.bash" ]; then
    source "$HOME/ros2_ws/install/setup.bash"
  fi
  if [ -f "$HOME/mission_ws/install/setup.bash" ]; then
    source "$HOME/mission_ws/install/setup.bash"
  fi
  set -u
fi

# 2. Detectar automáticamente el backend:
#    En el ROSOrin Pro usamos 'ros2' (que publica en /safety/servo_cmd, /servo_controller y /safety/cmd_vel
#    sin chocar con el puerto serial /dev/ttyACM0).
SERIAL_DEV="/dev/ttyACM0"
if [ -e "/dev/rrc" ]; then
  SERIAL_DEV="/dev/rrc"
fi

if [ -n "$FORCE_BACKEND" ]; then
  ROBOT_BACKEND="$FORCE_BACKEND"
elif [ -z "${ROBOT_BACKEND:-}" ]; then
  if [ -f "/opt/ros/humble/setup.bash" ]; then
    ROBOT_BACKEND="ros2"
  elif [ -e "$SERIAL_DEV" ]; then
    ROBOT_BACKEND="serial"
  else
    ROBOT_BACKEND="mock"
  fi
fi

# 3. En el robot físico: detener button_scan.service y start_app_node.service
#    que acaparan /dev/rrc (/dev/ttyACM0) e impiden mover los servos y ruedas.
pause_factory_services() {
  echo "[run.sh] Liberando /dev/rrc deteniendo temporalmente button_scan.service y start_app_node.service..."
  sudo systemctl stop button_scan.service start_app_node.service wifi.service 2>/dev/null || true
  pkill -f "[b]utton_scan.py" 2>/dev/null || true
  pkill -f "[r]os_robot_controller" 2>/dev/null || true
  rm -f "$HOME/.openclaw/workspace/ESTOP_LOCK" 2>/dev/null || true
  sleep 0.5
}

if [ "$ROBOT_BACKEND" != "mock" ]; then
  pause_factory_services
fi

# 4. Asegurar que cargo (Rust) esté en PATH
if [ -f "$HOME/.cargo/env" ]; then
  source "$HOME/.cargo/env"
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "[run.sh] Instalando Rust (cargo) para compilar robot-bridge..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
fi

pkill -f rosorin-bridge 2>/dev/null || true

LOCAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || ipconfig getifaddr en0 2>/dev/null || echo 'localhost')"
if [ -n "$REMOTE_ROBOT_IP" ]; then
  BRIDGE_HOST_TARGET="$REMOTE_ROBOT_IP"
else
  BRIDGE_HOST_TARGET="$LOCAL_IP"
fi

echo "================================================================"
echo " ROSOrin Pro · Embodied AI con Gemini 3.8 Live y JS"
if [ -n "$REMOTE_ROBOT_IP" ]; then
  echo " Modo              : Laptop conectada a Robot Físico (--robot-ip $REMOTE_ROBOT_IP)"
else
  echo " Backend detectado : $ROBOT_BACKEND ($SERIAL_DEV)"
fi
echo " Bridge URL        : http://${BRIDGE_HOST_TARGET}:${BRIDGE_PORT}"
echo " Web App URL       : http://localhost:${WEB_PORT}"
echo "================================================================"

cleanup() {
  echo ""
  echo "[run.sh] Deteniendo motores y cerrando puente..."
  curl -s -X POST "http://${BRIDGE_HOST_TARGET}:${BRIDGE_PORT}/stop" >/dev/null 2>&1 || true
  if [ -n "${BRIDGE_PID:-}" ]; then
    kill "$BRIDGE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# 5. Compilar y levantar robot-bridge en :$BRIDGE_PORT (solo si no estamos apuntando a un --robot-ip remoto)
if [ -z "$REMOTE_ROBOT_IP" ]; then
  echo "[run.sh] Compilando e iniciando robot-bridge ($ROBOT_BACKEND) en :${BRIDGE_PORT}..."
  (
    cd "$ROOT_DIR/robot-bridge"
    cargo run --release -- --backend "$ROBOT_BACKEND" --serial-port "$SERIAL_DEV" --port "$BRIDGE_PORT"
  ) &
  BRIDGE_PID=$!

  if [ "$BRIDGE_ONLY" = true ]; then
    echo "[run.sh] Modo --bridge-only activo en :${BRIDGE_PORT}. Presiona Ctrl+C para detener."
    wait "$BRIDGE_PID"
    exit 0
  fi
else
  echo "[run.sh] Usando robot-bridge remoto en http://${REMOTE_ROBOT_IP}:${BRIDGE_PORT}..."
fi

# 6. Asegurar Node.js >= 22 y levantar la web app en :$WEB_PORT
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

export NEXT_PUBLIC_BRIDGE_URL="http://${BRIDGE_HOST_TARGET}:${BRIDGE_PORT}"
if [ -z "$REMOTE_ROBOT_IP" ] && [ "$ROBOT_BACKEND" != "mock" ]; then
  export NEXT_PUBLIC_LITE_MODE="1"
fi

echo "================================================================"
echo " Hub Completo (3D)   : http://localhost:${WEB_PORT}"
echo " Hub Ligero (Sin 3D) : http://localhost:${WEB_PORT}/robot"
echo " Bridge Hardware     : http://${BRIDGE_HOST_TARGET}:${BRIDGE_PORT}"
echo "================================================================"

# Pre-compilar en segundo plano todas las rutas para que el primer clic sea instantáneo
(
  sleep 4
  for route in "/robot" "/demos/roaster?lite=1" "/demos/gatekeeper?lite=1" "/demos/bughunter?lite=1" "/demos/bumblebee?lite=1"; do
    curl -s "http://127.0.0.1:${WEB_PORT}${route}" >/dev/null 2>&1 || true
  done
  echo "[run.sh] Rutas de los 4 demos pre-compiladas y listas."
) &

npm run dev -- -H 0.0.0.0 -p "$WEB_PORT"
