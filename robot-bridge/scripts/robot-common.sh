# shellcheck shell=bash
# ==============================================================================
# robot-common.sh — Salvaguardas compartidas por run.sh e iniciar-robot.sh.
# Se carga con `source`; no se ejecuta. Mensajes con el prefijo $ROSORIN_LOG_TAG.
#   rosorin_ensure_bridge_token <archivo>  BRIDGE_TOKEN del entorno, del archivo o uno nuevo (600)
#   rosorin_check_estop_lock               falla si otra app dejó el candado de E-stop
#   rosorin_pause_factory_services         libera /dev/rrc (button_scan / start_app_node)
#   rosorin_start_sensors <dir-de-logs>    levanta solo el LiDAR y la cámara de Hiwonder (sin /dev/rrc)
#   rosorin_stop_sensors                   apaga lo que levantó rosorin_start_sensors
#   rosorin_curl_with_token <args curl>    curl con x-bridge-token por stdin (nunca en argv)
#   rosorin_gemini_key <raíz-del-repo>     imprime la API key de Gemini (GEMINI_API_KEY) o nada
# ==============================================================================

ROSORIN_LOG_TAG="${ROSORIN_LOG_TAG:-[rosorin]}"
# Candado de E-stop de otra app (p. ej. el botón físico). Si existe, alguien pidió
# detener el robot: no se borra ni se ignora.
ROSORIN_ESTOP_LOCK_FILE="${ROSORIN_ESTOP_LOCK_FILE:-$HOME/.openclaw/workspace/ESTOP_LOCK}"

# Lee BRIDGE_TOKEN del entorno o de <archivo>; si no existe, lo genera (permisos 600).
rosorin_ensure_bridge_token() {
  local token_file="$1"
  if [ -n "${BRIDGE_TOKEN:-}" ]; then
    return 0
  fi
  if [ -s "$token_file" ]; then
    BRIDGE_TOKEN="$(tr -d '[:space:]' < "$token_file")"
    return 0
  fi
  local generated=""
  if command -v openssl >/dev/null 2>&1; then
    generated="$(openssl rand -hex 16)"
  else
    generated="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  (umask 077 && printf '%s\n' "$generated" > "$token_file")
  chmod 600 "$token_file"
  BRIDGE_TOKEN="$generated"
  echo "$ROSORIN_LOG_TAG Token del puente generado en $token_file (cópialo a tu laptop para usar --robot-ip)."
}

# Devuelve 1 (con explicación) si existe el candado de E-stop de otra app.
rosorin_check_estop_lock() {
  if [ -e "$ROSORIN_ESTOP_LOCK_FILE" ]; then
    echo "$ROSORIN_LOG_TAG Hay un STOP activo de otra app (candado de E-stop): $ROSORIN_ESTOP_LOCK_FILE" >&2
    echo "$ROSORIN_LOG_TAG Revisa por qué se activó y libéralo desde esa app (o bórralo tú a conciencia) antes de mover el robot." >&2
    return 1
  fi
  return 0
}

# En el robot físico: detener button_scan.service y start_app_node.service, que acaparan
# /dev/rrc (/dev/ttyACM0) e impiden mover servos y ruedas. No se toca wifi.service (perderíamos
# la red del escenario). Antes revisa el candado de E-stop (devuelve 1 si existe).
rosorin_pause_factory_services() {
  rosorin_check_estop_lock || return 1
  echo "$ROSORIN_LOG_TAG Liberando /dev/rrc: deteniendo temporalmente button_scan.service y start_app_node.service..."
  echo "$ROSORIN_LOG_TAG Ojo: mientras corre el puente, el botón físico de fábrica no actúa; usa POST /stop o el botón STOP de la web."
  sudo systemctl stop button_scan.service start_app_node.service 2>/dev/null || true
  pkill -f "[b]utton_scan.py" 2>/dev/null || true
  pkill -f "[r]os_robot_controller" 2>/dev/null || true
  sleep 0.5
}

# start_app_node es el bringup completo de Hiwonder (bringup.launch.py): además del controlador
# que ocupa /dev/rrc lanza el LiDAR (/scan_raw → filtro → /scan) y la cámara Aurora. Al detenerlo
# no queda /scan y el chasis se bloquea. Esto levanta solo esos dos launch del paquete peripherals,
# con el mismo entorno que usa el servicio (~/.zshrc: LIDAR_TYPE, DEPTH_CAMERA_TYPE, need_compile…).
# No mueve nada: ni init_pose ni el controlador. Si ya corren (lanzados a mano), no los duplica.
ROSORIN_SENSOR_PIDS=()
rosorin_start_sensors() {
  local log_dir="$1" launch shell
  if ! command -v ros2 >/dev/null 2>&1 || ! ros2 pkg prefix peripherals >/dev/null 2>&1; then
    echo "$ROSORIN_LOG_TAG No encontré el paquete ROS 'peripherals': levanta el LiDAR y la cámara a mano o no habrá /scan." >&2
    return 0
  fi
  shell="bash"
  command -v zsh >/dev/null 2>&1 && [ -f "$HOME/.zshrc" ] && shell="zsh"
  for launch in lidar depth_camera; do
    if pgrep -f "[p]eripherals $launch.launch.py" >/dev/null 2>&1; then
      echo "$ROSORIN_LOG_TAG $launch.launch.py ya está corriendo: no lo lanzo otra vez."
      continue
    fi
    echo "$ROSORIN_LOG_TAG Levantando $launch.launch.py (log en $log_dir/$launch.log)..."
    if [ "$shell" = "zsh" ]; then
      nohup zsh -c "source ~/.zshrc >/dev/null 2>&1; exec ros2 launch peripherals $launch.launch.py" >"$log_dir/$launch.log" 2>&1 < /dev/null &
    else
      nohup ros2 launch peripherals "$launch.launch.py" >"$log_dir/$launch.log" 2>&1 < /dev/null &
    fi
    ROSORIN_SENSOR_PIDS+=("$!")
  done
}

rosorin_stop_sensors() {
  local pid
  for pid in "${ROSORIN_SENSOR_PIDS[@]+"${ROSORIN_SENSOR_PIDS[@]}"}"; do
    # TERM, no INT: un proceso en segundo plano de un shell no interactivo nace ignorando SIGINT
    kill -TERM "$pid" 2>/dev/null || true
  done
  ROSORIN_SENSOR_PIDS=()
}

# curl con el token en un header leído de stdin (`-H @-`, curl >= 7.55): el token no aparece en
# `ps` ni en la URL. Uso: rosorin_curl_with_token -s -X POST http://127.0.0.1:9000/stop
rosorin_curl_with_token() {
  printf 'x-bridge-token: %s\n' "${BRIDGE_TOKEN:-}" | curl -H @- "$@"
}

# API key de Gemini para el navegador: GEMINI_API_KEY del entorno, si no la de web/.env.local o
# web/.env, y como último recurso NEXT_PUBLIC_GEMINI_API_KEY (desaconsejada: Next la incrusta en el
# bundle público). Los lanzadores la pasan solo en el fragmento de la URL (#token=…&gemini_key=…),
# que no llega al servidor; la web la guarda en localStorage y la quita de la barra.
# Uso: GEMINI_KEY="$(rosorin_gemini_key "$ROOT_DIR")"
rosorin_gemini_key() {
  local root="$1" file var value
  if [ -n "${GEMINI_API_KEY:-}" ]; then
    printf '%s' "$GEMINI_API_KEY"
    return 0
  fi
  for var in GEMINI_API_KEY NEXT_PUBLIC_GEMINI_API_KEY; do
    for file in "$root/web/.env.local" "$root/web/.env"; do
      [ -f "$file" ] || continue
      value="$(sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}$var[[:space:]]*=[[:space:]]*//p" "$file" | tail -n1)"
      value="$(printf '%s' "$value" | sed "s/[[:space:]]*#.*$//; s/^[\"']//; s/[\"']$//" | tr -d '[:space:]')"
      if [ -n "$value" ]; then
        if [ "$var" = "NEXT_PUBLIC_GEMINI_API_KEY" ]; then
          echo "$ROSORIN_LOG_TAG AVISO: uso NEXT_PUBLIC_GEMINI_API_KEY de $file; renómbrala a GEMINI_API_KEY (lo NEXT_PUBLIC_* termina en el bundle público)." >&2
        fi
        printf '%s' "$value"
        return 0
      fi
    done
  done
  if [ -n "${NEXT_PUBLIC_GEMINI_API_KEY:-}" ]; then
    echo "$ROSORIN_LOG_TAG AVISO: uso NEXT_PUBLIC_GEMINI_API_KEY del entorno; usa GEMINI_API_KEY." >&2
    printf '%s' "$NEXT_PUBLIC_GEMINI_API_KEY"
  fi
  return 0
}
