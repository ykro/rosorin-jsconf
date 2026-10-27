#!/usr/bin/env bash
# ==============================================================================
# ensayo.sh — Ensayo con el robot físico, de punta a punta, con un solo script en cada lado.
#
# Uso:
#   ./ensayo.sh --robot                     # EN EL ROBOT: espera la Wi-Fi e imprime la IP, actualiza,
#                                           # compila y levanta el bridge y la web (:3000)
#   ./ensayo.sh --laptop --ip <IP>          # EN LA LAPTOP: trae el token, copia los MP3, abre la web
#                                           # del robot en Chrome y corre la guía del ensayo
#   ... --laptop-server                     # en los dos lados: la web corre en la laptop (localhost)
#   ./ensayo.sh --laptop --mock             # contra el gemelo local (./run.sh --mock en la laptop)
#   ./ensayo.sh --robot-ip <IP> [--ssh <usuario>@<IP>]   # solo la guía (bridge y web ya levantados)
#
# Opciones: --ip/--robot-ip <IP> (también --ip=<IP>), --ssh <usuario>@<IP> (en --laptop por defecto
# ubuntu@<IP>, o ROBOT_USER), --robot-repo <ruta>, --port <P>, --laptop-server, --solo-auto,
# --calibrar (--robot).
#
# La guía verifica solo lo que se puede medir (bridge, token, worker, LiDAR, STOP) y te guía en lo
# que necesita tus ojos (orientación del LiDAR, ruedas, choques, distancia de frenado). Antes de mover
# el robot siempre pide confirmación; con --solo-auto no mueve nada. Resultado: resumen en pantalla
# y bitácora en ensayo-<fecha>.log (fuera de git). Requisitos: curl >= 7.55, python3 y, para --laptop
# contra el robot, acceso SSH a él. Detalles en docs/ENSAYO.md.
# ==============================================================================
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=robot-bridge/scripts/robot-common.sh
ROSORIN_LOG_TAG="[ensayo]" source "$ROOT_DIR/robot-bridge/scripts/robot-common.sh"

MODE="guia"
ROBOT_IP=""
BRIDGE_PORT="${BRIDGE_PORT:-9000}"
WEB_PORT="${WEB_PORT:-3000}"
ROBOT_SSH=""
ROBOT_REPO="${ROBOT_REPO:-~/Desktop/rosorin-jsconf}"
SOLO_AUTO=false
MOCK=false
CALIBRAR=false
DEMO=false
LAPTOP_SERVER=false

while [ $# -gt 0 ]; do
  case "$1" in
    --robot) MODE="robot"; shift ;;
    --laptop) MODE="laptop"; shift ;;
    --robot-ip|--ip) ROBOT_IP="${2:-}"; shift 2 ;;
    --robot-ip=*|--ip=*) ROBOT_IP="${1#*=}"; shift ;;
    --port) BRIDGE_PORT="${2:-}"; shift 2 ;;
    --ssh) ROBOT_SSH="${2:-}"; shift 2 ;;
    --ssh=*) ROBOT_SSH="${1#*=}"; shift ;;
    --robot-repo) ROBOT_REPO="${2:-}"; shift 2 ;;
    --solo-auto) SOLO_AUTO=true; shift ;;
    --calibrar) CALIBRAR=true; shift ;;
    --demo) DEMO=true; shift ;;
    --laptop-server) LAPTOP_SERVER=true; shift ;;
    --mock) MOCK=true; ROBOT_IP="127.0.0.1"; shift ;;
    -h|--help) sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "[ensayo] Opción desconocida: $1 (usa --help)" >&2; exit 1 ;;
  esac
done

# Pregunta s/n. Devuelve 0 si la respuesta es sí.
ask() {
  local answer
  read -r -p "  ¿$1? [s/n] " answer
  [[ "$answer" =~ ^[sSyY] ]]
}

# ==============================================================================
# --robot: todo lo que se corre en el robot, hasta dejar el bridge levantado.
# ==============================================================================

# Imprime "<ip> <interfaz> <ssid>" de la primera interfaz Wi-Fi con IPv4, o nada si aún no hay.
# Sin ninguna interfaz Wi-Fi (robot con cable) usa la primera IP de la máquina.
robot_network() {
  local dir dev ip ssid any_wifi=false
  for dir in /sys/class/net/*; do
    [ -d "$dir/wireless" ] || continue
    any_wifi=true
    dev="$(basename "$dir")"
    ip="$(ip -4 -o addr show dev "$dev" scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1)"
    if [ -n "$ip" ]; then
      ssid="$(iwgetid -r "$dev" 2>/dev/null || true)"
      [ -n "$ssid" ] || ssid="$(nmcli -t -f active,ssid dev wifi 2>/dev/null | sed -n 's/^yes://p' | head -n1)"
      echo "$ip $dev ${ssid:-?}"
      return 0
    fi
  done
  if [ "$any_wifi" = false ]; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    [ -n "$ip" ] && echo "$ip (sin-wifi) -"
  fi
  return 0
}

wait_for_network() {
  local net waiting=false
  while :; do
    net="$(robot_network)"
    [ -n "$net" ] && break
    if [ "$waiting" = false ]; then
      echo "[ensayo] Aún no hay conexión Wi-Fi. Reviso cada 2 s (Ctrl+C para salir)..."
      waiting=true
    fi
    sleep 2
  done
  read -r ROBOT_IP NET_DEV NET_SSID <<< "$net"
}

robot_banner() {
  local laptop_cmd="./ensayo.sh --laptop --ip $ROBOT_IP"
  [ "$DEMO" = true ] && laptop_cmd="./demo.sh --laptop --ip $ROBOT_IP"
  [ "$USER" = "ubuntu" ] || laptop_cmd+=" --ssh $USER@$ROBOT_IP"
  [ "$ROOT_DIR" = "$HOME/Desktop/rosorin-jsconf" ] || laptop_cmd+=" --robot-repo $ROOT_DIR"
  [ "$LAPTOP_SERVER" = true ] && laptop_cmd+=" --laptop-server"
  echo "================================================================"
  if [ "$NET_DEV" = "(sin-wifi)" ]; then
    echo " Sin interfaz Wi-Fi: uso la red de la máquina"
  else
    echo " Wi-Fi conectada : $NET_SSID ($NET_DEV)"
  fi
  echo " IP del robot    : $ROBOT_IP"
  if [ "$LAPTOP_SERVER" = true ]; then
    echo " Web             : en la laptop (--laptop-server)"
  else
    echo " Web             : http://$ROBOT_IP:$WEB_PORT (la abre la laptop en Chrome)"
  fi
  echo " En la laptop    : $laptop_cmd"
  echo "================================================================"
}

# git pull del robot. Sin internet sigue con el commit actual; si el pull no avanza en limpio
# (historial reescrito o cambios locales) pregunta antes de descartar nada.
robot_update() {
  local head
  head="$(git -C "$ROOT_DIR" rev-parse --short HEAD)"
  echo "[ensayo] Actualizando el repo (commit actual $head)..."
  if ! git -C "$ROOT_DIR" fetch origin; then
    echo "[ensayo] AVISO: git fetch falló (¿la red tiene internet?). Sigo con $head."
    return 0
  fi
  if git -C "$ROOT_DIR" merge --ff-only origin/main >/dev/null 2>&1; then
    echo "[ensayo] Repo en $(git -C "$ROOT_DIR" rev-parse --short HEAD) (origin/main)."
    return 0
  fi
  echo "[ensayo] El repo no avanza en limpio hasta origin/main. Cambios locales:"
  git -C "$ROOT_DIR" status --short | sed 's/^/    /'
  if ask "Descarto los cambios locales y dejo el robot igual a origin/main (git reset --hard origin/main)"; then
    git -C "$ROOT_DIR" reset --hard origin/main || exit 1
  else
    echo "[ensayo] AVISO: sigo con $head; la guía marcará que el robot no tiene el commit de la laptop."
  fi
}

# Imprime por qué hay que (re)calibrar la sombra del brazo y devuelve 0; si está al día, nada y 1.
# Una calibración hecha con otra orientación del LiDAR (o sin registrarla) no sirve.
calibration_stale() {
  python3 - "$ROOT_DIR/robot-bridge/scripts" <<'PY'
import json, sys
sys.path.insert(0, sys.argv[1])
import ros2_worker as w
try:
    with open(w.ARM_SHADOW_FILE, encoding="utf-8") as f:
        data = json.load(f)
except FileNotFoundError:
    sys.exit(print("Este robot no tiene calibrada la sombra del brazo") or 0)
except Exception:
    sys.exit(print(f"No puedo leer {w.ARM_SHADOW_FILE}") or 0)
if "lidar_offset_deg" not in data:
    sys.exit(print("La sombra del brazo se calibró sin registrar la orientación del LiDAR") or 0)
import calibrar_sombra as c
if not str(data.get("method", "")).startswith(c.CALIBRATION_METHOD):
    sys.exit(print("La sombra se calibró con el calibrador anterior (sin selección geométrica de poses)") or 0)
if float(data["lidar_offset_deg"]) != float(w.LIDAR_ANGLE_OFFSET_DEG):
    sys.exit(print(f"La sombra se calibró con el LiDAR a {data['lidar_offset_deg']:g}° y ahora está a {w.LIDAR_ANGLE_OFFSET_DEG:g}°") or 0)
sys.exit(1)
PY
}

# La sombra del brazo se calibra con el bridge levantado: lo levanta en segundo plano, calibra y
# lo apaga, para que el bridge final cargue arm-shadow.json.
robot_calibrate() {
  local log pid
  log="$(mktemp "${TMPDIR:-/tmp}/rosorin-calibrar.XXXXXX")"
  echo "[ensayo] Levanto el bridge en segundo plano para calibrar (log en $log)..."
  "$ROOT_DIR/run.sh" --bridge-only </dev/null >"$log" 2>&1 &
  pid=$!
  for _ in $(seq 1 60); do
    curl -s -m 1 -o /dev/null "http://127.0.0.1:$BRIDGE_PORT/health" && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if curl -s -m 1 -o /dev/null "http://127.0.0.1:$BRIDGE_PORT/health"; then
    make -C "$ROOT_DIR" calibrar-sombra || echo "[ensayo] AVISO: la calibración falló; la guía lo verá en la sección 4."
  else
    echo "[ensayo] AVISO: el bridge no levantó para calibrar. Últimas líneas:"
    tail -n 15 "$log" | sed 's/^/    /'
  fi
  kill -TERM "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
}

# Build estático de la web (Next.js `output: export` → web/out), solo si cambió web/ desde el último.
# Sin clave de Gemini en el bundle (se sirve a la LAN) y sin modo ligero: el 3D lo dibuja el
# navegador de la laptop, no el Jetson.
robot_build_web() {
  local web="$ROOT_DIR/web" want
  want="$(git -C "$ROOT_DIR" rev-parse HEAD:web 2>/dev/null)"
  [ -z "$(git -C "$ROOT_DIR" status --porcelain -- web 2>/dev/null)" ] || want="dirty-$(date +%s)"
  if [ -f "$web/out/index.html" ] && [ "$(cat "$web/out/.rosorin-build" 2>/dev/null)" = "$want" ]; then
    echo "[ensayo] La web del robot ya está compilada para este commit."
    return 0
  fi
  export PATH="$HOME/.local/share/fnm:$HOME/.fnm:$PATH"
  command -v fnm >/dev/null 2>&1 && eval "$(fnm env)"
  if ! command -v npm >/dev/null 2>&1; then
    echo "[ensayo] No hay Node/npm en el robot: no puedo compilar la web. Usa --laptop-server en los dos lados." >&2
    return 1
  fi
  if [ ! -d "$web/node_modules" ] || [ "$web/package-lock.json" -nt "$web/node_modules/.package-lock.json" ]; then
    echo "[ensayo] Instalando dependencias de la web (npm ci)..."
    (cd "$web" && npm ci --no-audit --no-fund) || return 1
  fi
  echo "[ensayo] Compilando la web estática (npm run build, tarda unos minutos en el Jetson)..."
  (cd "$web" && NEXT_PUBLIC_LITE_MODE= npm run build) || return 1
  printf '%s\n' "$want" > "$web/out/.rosorin-build"
}

# Sirve web/out en 0.0.0.0:$WEB_PORT (más web/public, para los MP3 que la laptop copia después del
# build). /robot → robot.html, como el hosting estático. Python puro: casi nada de CPU en el Jetson.
ROBOT_WEB_PID=""
robot_start_web() {
  if curl -s -m 1 -o /dev/null "http://127.0.0.1:$WEB_PORT/"; then
    echo "[ensayo] AVISO: ya hay algo sirviendo en :$WEB_PORT; lo dejo así."
    return 0
  fi
  python3 - "$ROOT_DIR/web/out" "$ROOT_DIR/web/public" "$WEB_PORT" >/dev/null 2>&1 <<'PY' &
import http.server, os, posixpath, sys, urllib.parse

ROOTS = [os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])]


class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        rel = posixpath.normpath(urllib.parse.unquote(urllib.parse.urlsplit(path).path)).lstrip("/")
        for root in ROOTS:
            base = os.path.join(root, rel)
            for cand in (base, base + ".html", os.path.join(base, "index.html")):
                if os.path.isfile(cand):
                    return cand
        return os.path.join(ROOTS[0], rel or "index.html")

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer(("0.0.0.0", int(sys.argv[3])), Handler).serve_forever()
PY
  ROBOT_WEB_PID=$!
  for _ in $(seq 1 20); do
    curl -s -m 1 -o /dev/null "http://127.0.0.1:$WEB_PORT/" && return 0
    sleep 0.25
  done
  echo "[ensayo] AVISO: la web estática no respondió en :$WEB_PORT."
}

stop_robot_web() {
  [ -n "$ROBOT_WEB_PID" ] && kill -TERM "$ROBOT_WEB_PID" 2>/dev/null
  ROBOT_WEB_PID=""
}

run_robot_mode() {
  if [ ! -f /opt/ros/humble/setup.bash ] && [ ! -e /dev/rrc ]; then
    echo "[ensayo] --robot se corre en el robot (no encuentro ROS 2 Humble ni /dev/rrc). En la laptop usa --laptop." >&2
    exit 1
  fi
  rosorin_check_estop_lock || exit 1
  export BRIDGE_PORT  # run.sh lo toma del entorno (--port)
  wait_for_network
  robot_banner
  # sudo una vez al principio: run.sh detiene servicios de fábrica y, en segundo plano, no puede pedirla
  sudo -v || exit 1
  robot_update
  [ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
  echo "[ensayo] Compilando el bridge (make build-robot)..."
  make -C "$ROOT_DIR" build-robot || exit 1
  local reason
  if [ "$CALIBRAR" = true ]; then
    robot_calibrate
  elif reason="$(calibration_stale)"; then
    if [ "$DEMO" = true ]; then
      echo "[ensayo] AVISO: $reason. Calíbrala en el ensayo (./ensayo.sh --robot)."
    else
      echo "[ensayo] $reason."
      if ask "La calibro ahora (mueve solo el brazo; 50 cm libres)"; then
        robot_calibrate
      fi
    fi
  fi
  if [ "$LAPTOP_SERVER" = false ]; then
    if robot_build_web; then
      trap stop_robot_web EXIT
      robot_start_web
    else
      echo "[ensayo] AVISO: sin web en el robot. En la laptop usa --laptop-server."
      LAPTOP_SERVER=true
    fi
  fi
  wait_for_network
  robot_banner
  if [ "$LAPTOP_SERVER" = true ]; then
    echo "[ensayo] Levanto el bridge (make robot). Ctrl+C lo detiene y enclava la E-stop."
    cd "$ROOT_DIR" && exec ./run.sh --bridge-only
  fi
  echo "[ensayo] Levanto el bridge (make robot) con la web en :$WEB_PORT. Ctrl+C detiene los dos y enclava la E-stop."
  cd "$ROOT_DIR" && ./run.sh --bridge-only
  exit $?
}

[ "$MODE" = "robot" ] && run_robot_mode

# ==============================================================================
# --laptop: actualiza, trae el token, levanta la web y sigue con la guía.
# ==============================================================================
WEB_PID=""
WEB_TMP=""

# run.sh corre en su propio grupo de procesos: TERM solo a run.sh no basta (bash posterga su trap
# hasta que termine `npm run dev`), así que se manda al grupo entero. La salida de run.sh manda
# /stop al bridge.
stop_web() {
  if [ -n "$WEB_PID" ] && kill -0 "$WEB_PID" 2>/dev/null; then
    echo "[ensayo] Cerrando la web (run.sh manda /stop al bridge)..."
    kill -TERM -- "-$WEB_PID" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$WEB_PID" 2>/dev/null || break; sleep 0.5; done
    kill -KILL -- "-$WEB_PID" 2>/dev/null
  fi
  # El navegador lee la página que redirige al arrancar: no la borres antes de que la abra
  if [ -n "$OPENED_AT" ]; then
    while [ $((SECONDS - OPENED_AT)) -lt 6 ]; do sleep 1; done
  fi
  [ -n "$WEB_TMP" ] && rm -rf "$WEB_TMP"
}

# Fin de la guía. En --laptop interactivo deja la web abierta para las demos hasta Ctrl+C.
finish() {
  local code="$1"
  if [ "$MODE" = "laptop" ] && [ -n "$WEB_PID" ] && [ "$SOLO_AUTO" = false ] && [ -t 0 ]; then
    echo ""
    echo "[ensayo] La web sigue en $WEB_URL para las demos. Ctrl+C la cierra (y manda /stop al robot)."
    wait "$WEB_PID"
  fi
  exit "$code"
}

# Fragmento con el token (la web lo guarda y lo borra de la barra; el fragmento nunca llega al
# servidor). La API key de Gemini NUNCA va en la URL: la web se la pide al bridge.
WEB_FRAG=""
web_fragment() {
  WEB_FRAG="${BRIDGE_TOKEN:+#token=$BRIDGE_TOKEN}"
}

# ¿El bridge tiene GEMINI_API_KEY (web/.env de donde corre el bridge)? Solo lee "configured": la
# key no pasa por esta terminal. Devuelve 0 si la tiene.
bridge_has_gemini_key() {
  rosorin_curl_with_token -s -m 3 "http://$ROBOT_IP:$BRIDGE_PORT/config/gemini-key" 2>/dev/null |
    python3 -c 'import json,sys
try: sys.exit(0 if json.load(sys.stdin).get("configured") else 1)
except Exception: sys.exit(1)'
}

gemini_key_notice() {
  if bridge_has_gemini_key; then
    echo "[ensayo] La web toma la API key de Gemini del bridge (GEMINI_API_KEY en web/.env)."
  else
    echo "[ensayo] AVISO: falta la API key de Gemini: el bridge no tiene GEMINI_API_KEY (web/.env). La web te la pedirá y solo la usa mientras la página está abierta."
  fi
}
OPENED_AT=""

# Página local (600) que redirige a la URL con el token: así no va en argv ni en la terminal.
write_opener() {
  (umask 077 && printf '<!doctype html><meta charset="utf-8"><script>location.replace("%s")</script>\n' "$1" > "$WEB_TMP/abrir.html")
  OPENED_AT=$SECONDS
}

# Chrome o Chromium de la laptop, o nada.
find_chrome() {
  local c
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  for c in google-chrome google-chrome-stable chromium chromium-browser; do
    command -v "$c" >/dev/null 2>&1 && { command -v "$c"; return 0; }
  done
  return 1
}

# La web del robot llega por http://<IP>: sin contexto seguro el navegador no da el micrófono.
# --unsafely-treat-insecure-origin-as-secure lo concede solo a ese origen, y Chrome lo respeta solo
# con un --user-data-dir propio (perfil aparte, persistente: guarda la clave de Gemini y el token).
CHROME_PROFILE="${ROSORIN_CHROME_PROFILE:-$HOME/.cache/rosorin-chrome}"
open_chrome() {
  local chrome="$1" url="$2" origin="$3"
  write_opener "$url"
  mkdir -p "$CHROME_PROFILE"
  nohup "$chrome" --user-data-dir="$CHROME_PROFILE" --unsafely-treat-insecure-origin-as-secure="$origin" \
    --no-first-run --no-default-browser-check "file://$WEB_TMP/abrir.html" >/dev/null 2>&1 </dev/null &
}

# Abre la web local (localhost ya es contexto seguro) en el navegador por defecto.
open_web() {
  local url="$1" page="$WEB_TMP/abrir.html"
  write_opener "$url"
  if command -v open >/dev/null 2>&1; then
    open "$page"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$page" >/dev/null 2>&1
  else
    echo "[ensayo] Abre a mano la URL con el token: está en $WEB_TMP/web.log (no proyectes esa terminal)."
  fi
}

# Los MP3 de Bumblebee no van en git (derechos de autor): viven en la laptop y se copian al robot,
# donde se quedan. Solo viajan los que faltan o cambiaron; nunca borra nada en el robot.
sync_clips() {
  local src="$ROOT_DIR/web/public/songs/clips" dest="$ROBOT_REPO/web/public/songs/clips"
  local local_list remote_list missing total
  local_list="$(cd "$src" 2>/dev/null && ls -1 -- *.mp3 2>/dev/null | LC_ALL=C sort)"
  total="$(printf '%s' "$local_list" | grep -c . || true)"
  if [ "$total" = "0" ]; then
    echo "[ensayo] AVISO: no hay MP3 en $src: no copio nada al robot (Bumblebee no tendrá canciones)."
    return 0
  fi
  remote_list="$(ssh -o ConnectTimeout=5 "$ROBOT_SSH" "mkdir -p $dest && cd $dest && ls -1 | grep '\.mp3\$' | LC_ALL=C sort" 2>/dev/null)" || {
    echo "[ensayo] AVISO: no pude revisar los MP3 del robot por SSH."
    return 0
  }
  missing="$(LC_ALL=C comm -23 <(printf '%s\n' "$local_list") <(printf '%s\n' "$remote_list") | grep -c . || true)"
  if [ "$missing" = "0" ]; then
    echo "[ensayo] El robot ya tiene los $total MP3 de Bumblebee; reviso que no haya cambiado ninguno..."
  else
    echo "[ensayo] Al robot le faltan $missing de $total MP3 de Bumblebee: los copio..."
  fi
  if (cd "$src" && rsync -a -- *.mp3 "$ROBOT_SSH:$dest/"); then
    echo "[ensayo] MP3 al día en el robot ($dest)."
  else
    echo "[ensayo] AVISO: rsync de los MP3 falló; Bumblebee en el robot puede quedar sin canciones."
  fi
}

run_laptop_setup() {
  local token_url="" chrome=""
  # El gemelo (--mock) corre en la laptop: su web también.
  [ "$MOCK" = true ] && LAPTOP_SERVER=true
  if [ "$LAPTOP_SERVER" = false ] && ! chrome="$(find_chrome)"; then
    echo "[ensayo] AVISO: no encontré Chrome ni Chromium para abrir la web del robot con micrófono; uso --laptop-server."
    LAPTOP_SERVER=true
  fi
  if [ "$MOCK" = false ]; then
    if [ -z "$ROBOT_IP" ] && [ -n "$ROBOT_SSH" ]; then ROBOT_IP="${ROBOT_SSH#*@}"; fi
    if [ -z "$ROBOT_IP" ]; then
      read -r -p "[ensayo] IP del robot (la imprime ./ensayo.sh --robot): " ROBOT_IP
      [ -n "$ROBOT_IP" ] || exit 1
    fi
    [ -n "$ROBOT_SSH" ] || ROBOT_SSH="${ROBOT_USER:-ubuntu}@$ROBOT_IP"
  fi

  echo "[ensayo] Actualizando la laptop desde origin/main..."
  if git -C "$ROOT_DIR" fetch -q origin && git -C "$ROOT_DIR" merge -q --ff-only origin/main 2>/dev/null; then
    local ahead
    ahead="$(git -C "$ROOT_DIR" rev-list --count origin/main..HEAD)"
    [ "$ahead" = "0" ] || echo "[ensayo] AVISO: la laptop tiene $ahead commit(s) sin push: el robot no los verá con git pull."
  else
    echo "[ensayo] AVISO: no pude avanzar la laptop hasta origin/main; sigo con $(git -C "$ROOT_DIR" rev-parse --short HEAD)."
  fi

  if [ "$MOCK" = false ]; then
    local waiting=false
    until curl -s -m 2 -o /dev/null "http://$ROBOT_IP:$BRIDGE_PORT/health"; do
      if [ "$waiting" = false ]; then
        echo "[ensayo] Esperando el bridge en http://$ROBOT_IP:$BRIDGE_PORT (en el robot: ./ensayo.sh --robot). Ctrl+C para salir..."
        waiting=true
      fi
      sleep 2
    done
    echo "[ensayo] El bridge del robot responde."
    # traer-token.sh no copia de nuevo un .bridge-token que el bridge ya acepta
    "$ROOT_DIR/traer-token.sh" "$ROBOT_SSH" "$ROBOT_REPO" | grep -v "Ahora corre:" || exit 1
    sync_clips
    BRIDGE_TOKEN="$(tr -d '[:space:]' < "$ROOT_DIR/.bridge-token")"
  fi

  WEB_TMP="$(mktemp -d "${TMPDIR:-/tmp}/rosorin-ensayo.XXXXXX")"
  chmod 700 "$WEB_TMP"
  trap stop_web EXIT

  if [ "$LAPTOP_SERVER" = false ]; then
    local robot_web="http://$ROBOT_IP:$WEB_PORT" waiting=false
    until curl -s -m 2 -o /dev/null "$robot_web/"; do
      if [ "$waiting" = false ]; then
        echo "[ensayo] Esperando la web del robot en $robot_web (la primera vez compila unos minutos; o usa --laptop-server en los dos lados)..."
        waiting=true
      fi
      sleep 2
    done
    web_fragment
    open_chrome "$chrome" "$robot_web/?bridge=http://$ROBOT_IP:$BRIDGE_PORT$WEB_FRAG" "$robot_web"
    WEB_URL="$robot_web"
    echo "[ensayo] Web del robot abierta en Chrome ($robot_web, perfil $CHROME_PROFILE)."
    gemini_key_notice
    return 0
  fi

  if curl -s -m 2 -o /dev/null "http://127.0.0.1:$WEB_PORT/"; then
    echo "[ensayo] AVISO: ya hay una web en :$WEB_PORT; la uso tal cual (revisa que apunte a este bridge)."
  else
    local run_args=(--robot-ip "$ROBOT_IP" --bridge-port "$BRIDGE_PORT" --web-port "$WEB_PORT")
    [ "$MOCK" = true ] && run_args=(--mock --bridge-port "$BRIDGE_PORT" --web-port "$WEB_PORT")
    echo "[ensayo] Levantando la web (./run.sh ${run_args[*]}; log en $WEB_TMP/web.log)..."
    # stdin de /dev/null: run.sh no debe leer las respuestas de la guía. set -m: grupo de procesos
    # propio, así el Ctrl+C de la guía no lo tumba a medias y stop_web lo cierra completo.
    set -m
    (cd "$ROOT_DIR" && exec ./run.sh "${run_args[@]}") </dev/null >"$WEB_TMP/web.log" 2>&1 &
    WEB_PID=$!
    set +m
    for _ in $(seq 1 180); do
      curl -s -m 2 -o /dev/null "http://127.0.0.1:$WEB_PORT/" && break
      kill -0 "$WEB_PID" 2>/dev/null || break
      sleep 1
    done
    if ! curl -s -m 2 -o /dev/null "http://127.0.0.1:$WEB_PORT/"; then
      echo "[ensayo] La web no levantó. Últimas líneas de run.sh:" >&2
      tail -n 20 "$WEB_TMP/web.log" | sed -E 's/#token=[^ ]*/#token=***/; s/^/    /' >&2
      exit 1
    fi
  fi
  if [ "$MOCK" = true ]; then
    # En --mock run.sh compila y levanta también el bridge: la web puede estar lista antes
    for _ in $(seq 1 120); do
      curl -s -m 1 -o /dev/null "http://127.0.0.1:$BRIDGE_PORT/health" && break
      sleep 1
    done
  else
    token_url="?bridge=http://$ROBOT_IP:$BRIDGE_PORT"
  fi
  web_fragment
  open_web "http://localhost:$WEB_PORT/$token_url$WEB_FRAG"
  WEB_URL="http://localhost:$WEB_PORT"
  echo "[ensayo] Web abierta en el navegador ($WEB_URL)."
  gemini_key_notice
}
WEB_URL=""

[ "$MODE" = "laptop" ] && run_laptop_setup

# --demo en la laptop: la web queda lista contra el robot, sin la guía del ensayo.
if [ "$DEMO" = true ]; then
  if [ "$MODE" != "laptop" ]; then
    echo "[ensayo] --demo va con --robot o --laptop. Usa ./demo.sh --robot o ./demo.sh --laptop --ip <IP>." >&2
    exit 1
  fi
  echo ""
  echo "[demo] Listo: web en $WEB_URL contra el bridge http://$ROBOT_IP:$BRIDGE_PORT."
  if [ -n "$WEB_PID" ]; then
    echo "[demo] Ctrl+C cierra la web (y manda /stop al robot)."
    wait "$WEB_PID"
  else
    echo "[demo] Bridge y web corren en el robot: Ctrl+C en el robot los detiene. Aquí ya no queda nada corriendo."
  fi
  exit 0
fi

# ==============================================================================
# Guía del ensayo (también la parte final de --laptop).
# ==============================================================================
if [ -z "$ROBOT_IP" ]; then
  echo "[ensayo] Falta --laptop, --robot-ip <IP> o --mock. Usa --help." >&2
  exit 1
fi

BASE="http://$ROBOT_IP:$BRIDGE_PORT"
# En --mock el bridge local (./run.sh --mock) no usa token: no leas el del robot.
if [ -z "${BRIDGE_TOKEN:-}" ] && [ "$MOCK" = false ] && [ -s "$ROOT_DIR/.bridge-token" ]; then
  BRIDGE_TOKEN="$(tr -d '[:space:]' < "$ROOT_DIR/.bridge-token")"
fi
if [ -z "${BRIDGE_TOKEN:-}" ] && [ "$MOCK" = false ]; then
  echo "[ensayo] No hay token. Corre ./ensayo.sh --laptop --ip $ROBOT_IP (lo trae solo) o ./traer-token.sh <usuario>@$ROBOT_IP" >&2
  exit 1
fi

LOG="$ROOT_DIR/ensayo-$(date +%Y%m%d-%H%M).log"
PASS=0; FAIL=0; WARN=0; MANUAL=0
FAILS=()

log() { printf '%s\n' "$*" | tee -a "$LOG"; }
section() { log ""; log "=== $* ==="; }
ok() { PASS=$((PASS + 1)); log "  [OK]     $*"; }
bad() { FAIL=$((FAIL + 1)); FAILS+=("$*"); log "  [FALLA]  $*"; }
warn() { WARN=$((WARN + 1)); log "  [AVISO]  $*"; }
note() { log "           $*"; }

# Pregunta s/n y la registra como OK o FALLA.
check_manual() {
  MANUAL=$((MANUAL + 1))
  if ask "$1"; then ok "$1"; else bad "$1"; fi
}
pause() { read -r -p "  $1 (Enter para seguir) " _; }
# Sector más cercano durante <segundos> (por defecto 2), sin los sectores de <ignorar> (separados por
# comas: los ciegos, que siempre valen 0.0). Un solo proceso que lee /status a ~10 Hz (el bridge
# limita a 30 req/s y la web también consulta). Token por stdin. Imprime "<m> <sector>".
min_sector_during() {
  printf '%s\n' "${BRIDGE_TOKEN:-}" | python3 -c '
import json, sys, time, urllib.request
token, base, secs = sys.stdin.readline().strip(), sys.argv[1], float(sys.argv[2])
keys = [k for k in ("front_m", "left_m", "right_m", "back_m") if k not in sys.argv[3].split(",")]
best = (9.0, "")
end = time.monotonic() + secs
while time.monotonic() < end:
    try:
        req = urllib.request.Request(base + "/status", headers={"x-bridge-token": token} if token else {})
        with urllib.request.urlopen(req, timeout=1) as resp:
            lidar = json.load(resp)["lidar"]
        best = min(best, min((float(lidar[k]), k) for k in keys))
    except Exception:
        pass
    time.sleep(0.1)
print("%.2f %s" % best)' "$BASE" "${1:-2}" "${2:-}"
}
# Sectores en 0.0 ahora (ciegos o sin cobertura), separados por comas: ninguno cuenta como medida.
blind_sectors() {
  jf "$(status_json)" '",".join(k for k in ("front_m","left_m","right_m","back_m") if d["lidar"][k] == 0.0)'
}
# Sectores sin cobertura del LiDAR (lidar.uncovered, p. ej. atrás: lo tapan el chasis y los cables),
# como "back_m,..."; vacío con un bridge viejo o en mock (360°).
uncovered_sectors() {
  jf "$(status_json)" '",".join(k + "_m" for k in d["lidar"].get("uncovered", []))'
}
# Confirma que el área está despejada antes de mover algo.
clear_area() {
  ask "Área despejada alrededor del robot y mano en el interruptor de encendido. ¿Muevo el robot"
}

# --- HTTP con el token por stdin (nunca en argv) -------------------------------
api() {
  # api <método> <ruta> [json] → imprime "<código>\n<cuerpo>"
  local method="$1" path="$2" body="${3:-}"
  local args=(-s -m 5 -X "$method" -w '\n%{http_code}' "$BASE$path")
  if [ -n "$body" ]; then args+=(-H 'content-type: application/json' --data "$body"); fi
  local out
  if [ -n "${BRIDGE_TOKEN:-}" ]; then out="$(rosorin_curl_with_token "${args[@]}")"; else out="$(curl "${args[@]}")"; fi
  printf '%s\n%s' "$(printf '%s' "$out" | tail -n1)" "$(printf '%s' "$out" | sed '$d')"
}
code_of() { printf '%s' "$1" | head -n1; }
body_of() { printf '%s' "$1" | tail -n +2; }
# jf <json> <expresión python sobre d> → valor
jf() { python3 -c 'import json,sys
try:
    d=json.loads(sys.argv[1])
    v=eval(sys.argv[2],{"d":d})
    print("" if v is None else v)
except Exception:
    print("")' "$1" "$2"; }
status_json() { body_of "$(api GET /status)"; }
sectors() { jf "$1" '" ".join("%s=%s" % (l, "sin LiDAR" if k in d["lidar"].get("uncovered", []) else "%.2f" % d["lidar"][k + "_m"]) for l, k in (("F", "front"), ("I", "left"), ("D", "right"), ("A", "back")))'; }
cmd_vel() { api POST /cmd_vel "{\"linear_x\":$1,\"linear_y\":$2,\"angular_z\":$3,\"duration_ms\":$4}"; }
gesture() { api POST /gesture "{\"name\":\"$1\",\"mood\":\"ensayo\"}"; }
stop_robot() { api POST /stop >/dev/null; }
release() { api POST /estop/release >/dev/null; }

trap 'echo; stop_robot; log "[ensayo] Interrumpido: envié /stop."; exit 130' INT

log "Ensayo ROSOrin Pro · $(date '+%Y-%m-%d %H:%M') · bridge $BASE"
log "Bitácora: $LOG"

# ==============================================================================
section "1. Preparación (antes de encender)"
if [ "$SOLO_AUTO" = false ] && [ "$MOCK" = false ]; then
  check_manual "El robot está en el piso o con al menos 30 cm libres al borde de la mesa (el LiDAR no ve el borde)"
  check_manual "La batería está cargada y tienes cargador o repuesto"
  check_manual "El interruptor de encendido está a tu alcance (con run.sh el botón físico de fábrica no actúa)"
  if curl -s -m 3 -o /dev/null "$BASE/health"; then
    ok "La laptop llega al bridge del robot ($BASE): están en la misma red."
  else
    bad "La laptop no llega a $BASE: ponla en la misma Wi-Fi que el robot (una red de invitados con aislamiento de clientes no deja que se vean) y usa la IP que imprime ./ensayo.sh --robot."
  fi
  check_manual "La terminal con el token NO se está proyectando"
else
  note "Omitido (--solo-auto o --mock)."
fi

# ==============================================================================
section "2. Versión y arranque"
LOCAL_HEAD="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')"
note "Commit en la laptop: $LOCAL_HEAD"
if [ -n "$(git -C "$ROOT_DIR" status --porcelain 2>/dev/null)" ]; then
  warn "La laptop tiene cambios sin commit."
fi
if [ -n "$ROBOT_SSH" ]; then
  ROBOT_HEAD="$(ssh -o ConnectTimeout=5 "$ROBOT_SSH" "git -C $ROBOT_REPO rev-parse --short HEAD" 2>/dev/null || true)"
  if [ -z "$ROBOT_HEAD" ]; then
    bad "No pude leer el commit del robot por SSH ($ROBOT_SSH:$ROBOT_REPO)."
  elif [ "$ROBOT_HEAD" = "$LOCAL_HEAD" ]; then
    ok "El robot tiene el mismo commit que la laptop ($ROBOT_HEAD)."
  else
    bad "El robot está en $ROBOT_HEAD y la laptop en $LOCAL_HEAD: en el robot corre git pull (o git fetch && git reset --hard origin/main) y make build-robot."
  fi
  BIN_NEWER="$(ssh "$ROBOT_SSH" "cd $ROBOT_REPO && b=robot-bridge/target/release/rosorin-bridge; [ -x \$b ] && [ -z \"\$(find robot-bridge/src robot-bridge/Cargo.toml robot-bridge/Cargo.lock -newer \$b 2>/dev/null)\" ] && echo si || echo no" 2>/dev/null || echo '?')"
  if [ "$BIN_NEWER" = "si" ]; then ok "El binario de release del robot es más nuevo que el código."; else bad "El binario del robot no está recompilado: corre make build-robot en el robot (bridge y worker van juntos)."; fi
else
  note "Sin --ssh: no reviso el commit ni el binario del robot."
fi

R="$(api GET /health)"
if [ "$(code_of "$R")" = "200" ]; then ok "GET /health responde 200."; else bad "El bridge no responde en $BASE (¿corriste make robot en el robot?)."; fi
if [ "$MODE" = "laptop" ] && [ "$LAPTOP_SERVER" = false ]; then
  WEB_CODE="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://$ROBOT_IP:$WEB_PORT/robot")"
  if [ "$WEB_CODE" = "200" ]; then ok "La web del robot responde (http://$ROBOT_IP:$WEB_PORT/robot)."; else bad "La web del robot respondió $WEB_CODE en /robot (¿./ensayo.sh --robot sin --laptop-server?)."; fi
fi

if [ -n "${BRIDGE_TOKEN:-}" ]; then
  NOAUTH="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$BASE/status")"
  if [ "$NOAUTH" = "401" ]; then ok "Sin token el bridge responde 401."; else bad "Sin token el bridge responde $NOAUTH (esperaba 401)."; fi
fi

R="$(api GET /status)"; S="$(body_of "$R")"
if [ "$(code_of "$R")" != "200" ]; then
  bad "GET /status con token responde $(code_of "$R"). ¿El token es el del robot? (./traer-token.sh)"
  log ""; log "No puedo seguir sin /status."; exit 1
fi
ok "GET /status con token responde 200."
BACKEND="$(jf "$S" 'd["backend"]')"
note "Backend: $BACKEND · batería: $(jf "$S" 'd["battery_mv"]') mV · LiDAR: $(jf "$S" 'd["lidar_source"]')"
# Con --backend ros2, `backend` trae el nombre del worker (stm32-board…, ros2-topics): el LiDAR dice la verdad.
if [ "$MOCK" = false ] && [ "$(jf "$S" 'd["lidar_source"]')" != "ros2" ]; then warn "El LiDAR viene de '$(jf "$S" 'd["lidar_source"]')' (en el robot se espera ros2; ¿el bridge cayó a mock o es serial?)."; fi
if [ "$(jf "$S" 'd["connected"]')" = "True" ]; then
  ok "El worker responde (connected=true)."
else
  bad "connected=false: el worker no responde los pings. Actualiza bridge y worker juntos (git pull + make build-robot) y reinicia make robot."
fi
if [ "$(jf "$S" 'd["estop_latched"]')" = "True" ]; then
  warn "La E-stop estaba enclavada; la libero para el ensayo."
  release
fi
if [ "$(jf "$S" 'd["lidar_stale"]')" = "True" ]; then
  bad "lidar_stale=true: no llega /scan. Revisa el driver del LiDAR (ros2 topic hz /scan)."
else
  ok "Llegan datos del LiDAR (lidar_stale=false)."
fi
if [ -n "$ROBOT_SSH" ]; then
  HZ="$(ssh "$ROBOT_SSH" "bash -lc 'source /opt/ros/humble/setup.bash >/dev/null 2>&1; timeout 6 ros2 topic hz /scan 2>/dev/null | grep -m1 \"average rate\"'" 2>/dev/null | awk '{print $3}')"
  if [ -n "$HZ" ]; then ok "/scan publica a ${HZ} Hz."; note "Valor medido: /scan ${HZ} Hz"; else warn "No pude medir ros2 topic hz /scan por SSH."; fi
fi

if [ "$SOLO_AUTO" = true ]; then
  section "Resumen (--solo-auto)"
  log "  OK: $PASS · FALLAS: $FAIL · AVISOS: $WARN"
  for f in "${FAILS[@]+"${FAILS[@]}"}"; do log "  - $f"; done
  [ "$FAIL" -eq 0 ]; finish $?
fi

# ==============================================================================
section "3. Orientación del LiDAR"
BASELINE="$(status_json)"
note "Sin obstáculos: $(sectors "$BASELINE")"
if [ "$MOCK" = true ]; then
  note "En mock no hay LiDAR real: omito la orientación."
else
  BLIND="$(blind_sectors)"
  UNCOVERED="$(uncovered_sectors)"
  COVERED_KEYS="$(python3 -c 'import sys; print(repr([k for k in ("front_m","left_m","right_m","back_m") if k not in sys.argv[1].split(",")]))' "$UNCOVERED")"
  for pair in "front_m:AL FRENTE" "left_m:A LA IZQUIERDA" "right_m:A LA DERECHA" "back_m:ATRÁS"; do
    key="${pair%%:*}"; label="${pair#*:}"
    if [[ ",$UNCOVERED," == *",$key,"* ]]; then
      warn "$label no tiene LiDAR (lo tapan el chasis y los cables): no lo pruebo. Hacia ese lado el robot no frena."
      continue
    fi
    if [[ ",$BLIND," == *",$key,"* ]]; then
      bad "El sector $key está ciego (0.0 m: tiene rayos pero ninguno sirve). Limpia o destapa la ventana del LiDAR; mientras tanto el freno bloquea moverse $label."
      continue
    fi
    pause "Pon una caja o botella (algo de al menos 15 cm de alto) a unos 20 cm $label del robot"
    NOW="$(status_json)"
    note "Con el objeto $label: $(sectors "$NOW")"
    LOWEST="$(jf "$NOW" "min($COVERED_KEYS, key=lambda k: d['lidar'][k])")"
    VAL="$(jf "$NOW" "round(d['lidar']['$key'],2)")"
    if [ "$LOWEST" = "$key" ] && python3 -c "import sys; sys.exit(0 if float('$VAL') < 0.35 else 1)"; then
      ok "El objeto $label baja $key a $VAL m."
    else
      bad "El objeto $label no baja $key (el sector más cercano es $LOWEST). El /scan está rotado o invertido: corrígelo con LIDAR_ANGLE_OFFSET_DEG (p. ej. 180 si frente y atrás están cambiados) o LIDAR_FLIP=1 (si izquierda y derecha están cambiadas) al levantar make robot."
    fi
  done
  pause "Quita el objeto y tapa el LiDAR con la mano"
  NOW="$(status_json)"
  note "LiDAR tapado: $(sectors "$NOW")"
  if [ "$(jf "$NOW" 'd["lidar"]["obstacle_alert"]')" = "True" ]; then ok "Con el LiDAR tapado se enciende obstacle_alert."; else bad "Con el LiDAR tapado no se enciende obstacle_alert."; fi
  pause "Destapa el LiDAR"
fi

# ==============================================================================
section "4. Sombra del brazo durante los gestos"
# "<gesto>:<1 si mueve el chasis, 0 si no>" para cada gesto de gestures.rs menos home
GESTURES="$(cd "$ROOT_DIR/web" && node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { parseGestures } from './scripts/gen-gestures.mjs';
const all = parseGestures(readFileSync('../robot-bridge/src/gestures.rs','utf8')).gestures;
console.log(Object.entries(all).filter(([n]) => n !== 'home')
  .map(([n, g]) => n + ':' + (g.steps.some(s => s.velocity && s.velocity.some(v => v !== 0)) ? 1 : 0)).join(' '));
" 2>/dev/null)"
if [ -z "$GESTURES" ]; then
  GESTURES="facepalm trash_toss chef_kiss suspicious_inspect victory_spin nod_yes shake_no wave_hello gatekeeper_hold gatekeeper_approve gatekeeper_reject point_cloud_run point_gemini_live point_firestore bumblebee_hype bumblebee_groove bumblebee_rock_out bumblebee_romance bumblebee_sad_droop bumblebee_sassy"
fi
note "Necesito 50 cm libres alrededor: varios gestos también mueven el chasis. Un sector bajo 0.28 m durante un gesto es el brazo visto como obstáculo; en los que mueven el chasis solo cuenta el frente (lo demás es el robot acercándose a algo)."
if clear_area; then
  SHADOWED=()
  BLIND="$(blind_sectors)"
  [ -z "$BLIND" ] || note "Sectores en 0.0 (ciegos o sin LiDAR) que no cuento: ${BLIND}"
  for spec in $GESTURES; do
    g="${spec%%:*}"; moves="${spec#*:}"; [ "$moves" = "$spec" ] && moves=0
    gesture "$g" >/dev/null
    read -r MIN WHERE < <(min_sector_during 2 "$BLIND")
    if ! python3 -c "import sys; sys.exit(0 if float('${MIN}') < 0.28 else 1)"; then
      note "${g}: sector mínimo ${MIN} m (${WHERE})"
    elif [ "$moves" = "1" ] && [ "$WHERE" != "front_m" ]; then
      note "${g}: sector mínimo ${MIN} m (${WHERE}); movió el chasis, no cuenta como sombra"
    else
      note "${g}: sector mínimo ${MIN} m (${WHERE})"
      SHADOWED+=("${g} → ${WHERE} ${MIN} m")
    fi
  done
  gesture home >/dev/null
  if [ ${#SHADOWED[@]} -eq 0 ]; then
    ok "Ningún gesto hace que el brazo bloquee el LiDAR."
  else
    bad "El brazo aparece como obstáculo en: ${SHADOWED[*]}. En el robot corre make calibrar-sombra (con el bridge levantado) y reinicia make robot."
  fi
  check_manual "Ningún gesto chocó con algo ni acercó el brazo a la torre del LiDAR"
else
  warn "Omití la prueba de gestos."
fi

# ==============================================================================
section "5. Sentido de las ruedas Mecanum"
if [[ ",$(uncovered_sectors)," == *",back_m,"* ]]; then
  note "Atrás no frena: el LiDAR no ve detrás del robot. El ensayo retrocede despacio (0.05 m/s, ~2.5 cm) y te lo pregunta antes."
fi
if clear_area; then
  # Hacia atrás el LiDAR no frena: el ensayo retrocede lento y corto (0.05 m/s × 0.5 s ≈ 2.5 cm,
  # el mismo límite que el bridge aplica a los gestos) y pide confirmarlo aparte.
  for spec in "0.10 0 0 600:hacia ADELANTE" "-0.05 0 0 500:hacia ATRÁS (despacio, ~2.5 cm)" "0 0.10 0 600:de lado a la IZQUIERDA" "0 -0.10 0 600:de lado a la DERECHA" "0 0 0.4 600:girando a la IZQUIERDA (antihorario)" "0 0 -0.4 600:girando a la DERECHA (horario)"; do
    read -r vx vy wz ms <<< "${spec%%:*}"; label="${spec#*:}"
    if [[ "$vx" == -* ]] && ! ask "Detrás del robot está libre. ¿Retrocedo despacio unos 2.5 cm"; then
      warn "Omití el movimiento $label."
      continue
    fi
    R="$(cmd_vel "$vx" "$vy" "$wz" "$ms")"
    if [ "$(code_of "$R")" = "423" ]; then bad "El movimiento $label respondió 423: la E-stop estaba enclavada."; release; continue; fi
    BLOCKED="$(jf "$(body_of "$R")" 'd.get("blocked")')"
    sleep 0.9
    if [ -n "$BLOCKED" ]; then bad "El movimiento $label salió bloqueado ($BLOCKED)."; continue; fi
    check_manual "El robot se movió $label"
  done
  stop_robot; release
else
  warn "Omití la prueba de ruedas."
fi

# ==============================================================================
section "6. STOP"
if clear_area; then
  gesture victory_spin >/dev/null
  sleep 0.8
  stop_robot
  sleep 0.15
  S="$(status_json)"
  WZ="$(jf "$S" 'abs(d["odometry"]["wz"])')"
  if [ "$(jf "$S" 'd["estop_latched"]')" = "True" ] && python3 -c "import sys; sys.exit(0 if float('${WZ:-1}') < 0.01 else 1)"; then
    ok "/stop durante victory_spin: giro en 0 y E-stop enclavada."
  else
    bad "/stop durante victory_spin no dejó wz=0 con la E-stop enclavada (wz=$WZ)."
  fi
  R="$(cmd_vel 0.1 0 0 300)"
  if [ "$(code_of "$R")" = "423" ]; then ok "Con la E-stop enclavada, cmd_vel responde 423."; else bad "Con la E-stop enclavada, cmd_vel responde $(code_of "$R") (esperaba 423)."; fi
  check_manual "El robot se detuvo al instante y el brazo no dio un tirón"
  release
  S="$(status_json)"
  if [ "$(jf "$S" 'd["estop_latched"]')" = "False" ]; then ok "POST /estop/release libera la E-stop."; else bad "La E-stop no se liberó."; fi

  pause "Ahora presiona Esc (o el botón STOP) en la web de la laptop"
  LATCHED=""
  for _ in $(seq 1 30); do
    [ "$(jf "$(status_json)" 'd["estop_latched"]')" = "True" ] && LATCHED=1 && break
    sleep 0.5
  done
  if [ -n "$LATCHED" ]; then ok "El STOP de la web enclava la E-stop."; else bad "El STOP de la web no enclavó la E-stop en 15 s."; fi
  check_manual "La web muestra el banner «STOP activo»"
  pause "Presiona «Liberar» en la web"
  if [ "$(jf "$(status_json)" 'd["estop_latched"]')" = "False" ]; then ok "«Liberar» en la web libera la E-stop."; else bad "«Liberar» no liberó la E-stop."; release; fi

  cmd_vel 0.08 0 0 600 >/dev/null
  sleep 1.0
  VX="$(jf "$(status_json)" 'abs(d["odometry"]["vx"])')"
  if python3 -c "import sys; sys.exit(0 if float('${VX:-1}') < 0.01 else 1)"; then ok "Watchdog: sin comandos nuevos el chasis para solo (600 ms)."; else bad "Watchdog: el chasis sigue con vx=$VX después de 1 s."; fi
  MANUAL=$((MANUAL + 1))
  pause "Con la web, avanza despacio hacia una caja de cartón hasta que el freno la detenga"
  read -r -p "  Distancia de frenado medida al frente (cm): " CM
  note "Valor medido: frenado al frente ${CM:-?} cm"
  pause "Repite de lado (strafe) hacia la caja"
  [[ "${CM:-}" =~ ^[0-9]+([.][0-9]+)?$ ]] || CM=""
  read -r -p "  Distancia de frenado medida de lado (cm): " CM2
  [[ "${CM2:-}" =~ ^[0-9]+([.][0-9]+)?$ ]] || CM2=""
  note "Valor medido: frenado de lado ${CM2:-?} cm"
  if [ -n "${CM:-}" ] && python3 -c "import sys; sys.exit(0 if float('$CM') >= 10 else 1)" 2>/dev/null; then ok "Frenado al frente: $CM cm."; else warn "Frenado al frente: ${CM:-sin dato} cm (menos de 10 cm es poco margen)."; fi
  check_manual "Si cortas la Wi-Fi de la laptop a media marcha, el robot para en menos de 1 s"
  check_manual "Con Ctrl+C en el bridge del robot, los motores paran"
else
  warn "Omití la prueba de STOP."
fi

# ==============================================================================
section "7. Demos"
check_manual "Los props impresos (llave, bandejas y tótems) están en su lugar"
if clear_area; then
  gesture gatekeeper_hold >/dev/null; sleep 1.0
  gesture gatekeeper_approve >/dev/null; sleep 2.0
  check_manual "La pinza soltó la llave sobre la bandeja VERDE"
  gesture gatekeeper_hold >/dev/null; sleep 1.0
  gesture gatekeeper_reject >/dev/null; sleep 3.0
  check_manual "La pinza soltó la llave sobre la bandeja ROJA"
  for t in point_cloud_run point_gemini_live point_firestore; do
    gesture "$t" >/dev/null; sleep 2.0
    check_manual "Con $t el brazo apunta al tótem correcto"
  done
  gesture home >/dev/null
else
  warn "Omití la prueba de bandejas y tótems."
fi
CLIPS="$(find "$ROOT_DIR/web/public/songs/clips" -maxdepth 1 -name '*.mp3' 2>/dev/null | wc -l | tr -d ' ')"
if [ "${CLIPS:-0}" -ge 168 ]; then ok "Hay $CLIPS MP3 de Bumblebee en la laptop."; else bad "Solo hay ${CLIPS:-0} MP3 en web/public/songs/clips (se necesitan 168 para Bumblebee)."; fi
if [ -n "$ROBOT_SSH" ]; then
  RCLIPS="$(ssh "$ROBOT_SSH" "find $ROBOT_REPO/web/public/songs/clips -maxdepth 1 -name '*.mp3' 2>/dev/null | wc -l" 2>/dev/null | tr -d ' ')"
  if [ "$MODE" = "laptop" ] && [ "$LAPTOP_SERVER" = false ]; then
    # La web la sirve el robot: Bumblebee baja los MP3 de ahí
    if [ "${RCLIPS:-0}" -ge 168 ] 2>/dev/null; then ok "Hay $RCLIPS MP3 en el robot (la web del robot los sirve)."; else bad "Solo hay ${RCLIPS:-?} MP3 en el robot: vuelve a correr ./ensayo.sh --laptop (los copia) o revisa el rsync."; fi
  else
    note "MP3 en el robot (solo hacen falta si la web corre en el robot): ${RCLIPS:-?}"
  fi
fi
GH="$(curl -s -m 5 -o /dev/null -w '%{http_code}' https://api.github.com/repos/ykro/rosorin-jsconf)"
if [ "$GH" = "200" ]; then ok "La red del lugar llega a la API de GitHub (Roaster)."; else warn "La API de GitHub respondió $GH: usa los presets del Roaster."; fi
R="$(api GET /config/gemini-key)"
if [ "$(code_of "$R")" = "200" ] && [ "$(jf "$(body_of "$R")" 'd.get("configured")')" = "True" ]; then
  ok "El bridge tiene GEMINI_API_KEY: la web la toma de ahí (nunca por la URL ni en el navegador)."
else
  warn "El bridge no tiene GEMINI_API_KEY (web/.env del robot)."
  check_manual "La API key de Gemini está ingresada en la web (solo dura mientras la página está abierta)"
fi
check_manual "Con el micrófono real, al interrumpir al robot calla y luego responde con audio"
check_manual "Con la bocina y los servos sonando no hay falsas interrupciones"

# ==============================================================================
section "8. Plan B"
SL="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -L https://jsconfmx26.web.app/slides)"
if [ "$SL" = "200" ]; then ok "Las slides publicadas responden 200."; else warn "jsconfmx26.web.app/slides respondió $SL."; fi
if [ -f "$ROOT_DIR/web/public/slides/index.html" ]; then ok "Hay copia local de las slides (web/public/slides/index.html)."; fi
check_manual "Probaste ./run.sh --mock en esta laptop como respaldo del robot"
check_manual "Tienes un video de respaldo de cada demo"

stop_robot
release
gesture home >/dev/null

# ==============================================================================
section "Resumen"
log "  OK: $PASS · FALLAS: $FAIL · AVISOS: $WARN · revisiones manuales: $MANUAL"
for f in "${FAILS[@]+"${FAILS[@]}"}"; do log "  - $f"; done
log ""
log "Bitácora con los valores medidos: $LOG"
[ "$FAIL" -eq 0 ]; finish $?
