#!/usr/bin/env bash
# ==============================================================================
# ensayo.sh — Guía del ensayo con el robot físico. Se corre EN LA LAPTOP.
#
# Uso:
#   ./ensayo.sh --robot-ip <IP> [--ssh <usuario>@<IP>] [--robot-repo <ruta>] [--solo-auto]
#   ./ensayo.sh --mock            # contra el bridge local (127.0.0.1:9000), para probar el script
#
# Verifica solo lo que se puede medir (bridge, token, worker, LiDAR, paros) y te guía en lo que
# necesita tus ojos (orientación del LiDAR, sentido de las ruedas, choques, distancia de frenado).
# Antes de mover el robot siempre pide confirmación. Con --solo-auto no mueve nada.
# Resultado: resumen en pantalla y bitácora en ensayo-<fecha>.log (fuera de git).
#
# Requisitos: curl >= 7.55, python3. El token se lee de BRIDGE_TOKEN o de .bridge-token
# (tráelo con ./traer-token.sh). Con --ssh también revisa el commit del robot y /scan.
# ==============================================================================
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=robot-bridge/scripts/robot-common.sh
ROSORIN_LOG_TAG="[ensayo]" source "$ROOT_DIR/robot-bridge/scripts/robot-common.sh"

ROBOT_IP=""
BRIDGE_PORT="${BRIDGE_PORT:-9000}"
ROBOT_SSH=""
ROBOT_REPO="${ROBOT_REPO:-~/Desktop/rosorin-jsconf}"
SOLO_AUTO=false
MOCK=false

while [ $# -gt 0 ]; do
  case "$1" in
    --robot-ip|--ip) ROBOT_IP="${2:-}"; shift 2 ;;
    --port) BRIDGE_PORT="${2:-}"; shift 2 ;;
    --ssh) ROBOT_SSH="${2:-}"; shift 2 ;;
    --robot-repo) ROBOT_REPO="${2:-}"; shift 2 ;;
    --solo-auto) SOLO_AUTO=true; shift ;;
    --mock) MOCK=true; ROBOT_IP="127.0.0.1"; shift ;;
    -h|--help) sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "[ensayo] Opción desconocida: $1 (usa --help)" >&2; exit 1 ;;
  esac
done

if [ -z "$ROBOT_IP" ]; then
  echo "[ensayo] Falta --robot-ip <IP> (o --mock). Usa --help." >&2
  exit 1
fi

BASE="http://$ROBOT_IP:$BRIDGE_PORT"
if [ -z "${BRIDGE_TOKEN:-}" ] && [ -s "$ROOT_DIR/.bridge-token" ]; then
  BRIDGE_TOKEN="$(tr -d '[:space:]' < "$ROOT_DIR/.bridge-token")"
fi
if [ -z "${BRIDGE_TOKEN:-}" ] && [ "$MOCK" = false ]; then
  echo "[ensayo] No hay token. Tráelo con ./traer-token.sh <usuario>@$ROBOT_IP" >&2
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

# Pregunta s/n. Devuelve 0 si la respuesta es sí.
ask() {
  local answer
  read -r -p "  ¿$1? [s/n] " answer
  [[ "$answer" =~ ^[sSyY] ]]
}
# Pregunta s/n y la registra como OK o FALLA.
check_manual() {
  MANUAL=$((MANUAL + 1))
  if ask "$1"; then ok "$1"; else bad "$1"; fi
}
pause() { read -r -p "  $1 (Enter para seguir) " _; }
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
sectors() { jf "$1" '"F=%.2f I=%.2f D=%.2f A=%.2f" % (d["lidar"]["front_m"], d["lidar"]["left_m"], d["lidar"]["right_m"], d["lidar"]["back_m"])'; }
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
  check_manual "La laptop está en la Wi-Fi WPA2 propia del robot, no en la del evento"
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
  BIN_NEWER="$(ssh "$ROBOT_SSH" "cd $ROBOT_REPO && b=robot-bridge/target/release/rosorin-bridge; [ -x \$b ] && [ \$b -nt robot-bridge/src/backend.rs ] && [ \$b -nt robot-bridge/src/main.rs ] && echo si || echo no" 2>/dev/null || echo '?')"
  if [ "$BIN_NEWER" = "si" ]; then ok "El binario de release del robot es más nuevo que el código."; else bad "El binario del robot no está recompilado: corre make build-robot en el robot (bridge y worker van juntos)."; fi
else
  note "Sin --ssh: no reviso el commit ni el binario del robot."
fi

R="$(api GET /health)"
if [ "$(code_of "$R")" = "200" ]; then ok "GET /health responde 200."; else bad "El bridge no responde en $BASE (¿corriste make robot en el robot?)."; fi

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
if [ "$MOCK" = false ] && [ "$BACKEND" != "ros2" ]; then warn "El backend es '$BACKEND' (en el robot se espera ros2)."; fi
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
  [ "$FAIL" -eq 0 ]; exit $?
fi

# ==============================================================================
section "3. Orientación del LiDAR"
BASELINE="$(status_json)"
note "Sin obstáculos: $(sectors "$BASELINE")"
if [ "$MOCK" = true ]; then
  note "En mock no hay LiDAR real: omito la orientación."
else
  for pair in "front_m:AL FRENTE" "left_m:A LA IZQUIERDA" "right_m:A LA DERECHA" "back_m:ATRÁS"; do
    key="${pair%%:*}"; label="${pair#*:}"
    pause "Pon una caja a unos 20 cm $label del robot"
    NOW="$(status_json)"
    note "Con la caja $label: $(sectors "$NOW")"
    LOWEST="$(jf "$NOW" 'min(["front_m","left_m","right_m","back_m"], key=lambda k: d["lidar"][k])')"
    VAL="$(jf "$NOW" "round(d['lidar']['$key'],2)")"
    if [ "$LOWEST" = "$key" ] && python3 -c "import sys; sys.exit(0 if float('$VAL') < 0.35 else 1)"; then
      ok "La caja $label baja $key a $VAL m."
    else
      bad "La caja $label no baja $key (el sector más cercano es $LOWEST). El /scan está rotado o invertido."
    fi
  done
  pause "Quita la caja y tapa el LiDAR con la mano"
  NOW="$(status_json)"
  note "LiDAR tapado: $(sectors "$NOW")"
  if [ "$(jf "$NOW" 'd["lidar"]["obstacle_alert"]')" = "True" ]; then ok "Con el LiDAR tapado se enciende obstacle_alert."; else bad "Con el LiDAR tapado no se enciende obstacle_alert."; fi
  pause "Destapa el LiDAR"
fi

# ==============================================================================
section "4. Sombra del brazo durante los gestos"
GESTURES="$(cd "$ROOT_DIR/web" && node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { parseGestures } from './scripts/gen-gestures.mjs';
console.log(Object.keys(parseGestures(readFileSync('../robot-bridge/src/gestures.rs','utf8')).gestures).filter(g => g !== 'home').join(' '));
" 2>/dev/null)"
if [ -z "$GESTURES" ]; then
  GESTURES="facepalm trash_toss chef_kiss suspicious_inspect victory_spin nod_yes shake_no wave_hello gatekeeper_hold gatekeeper_approve gatekeeper_reject point_cloud_run point_gemini_live point_firestore bumblebee_hype bumblebee_groove bumblebee_rock_out bumblebee_romance bumblebee_sad_droop bumblebee_sassy"
fi
note "Necesito 50 cm libres alrededor: cualquier sector bajo 0.28 m durante un gesto es el brazo visto como obstáculo."
if clear_area; then
  SHADOWED=()
  for g in $GESTURES; do
    gesture "$g" >/dev/null
    MIN="9"
    WHERE=""
    for _ in $(seq 1 30); do
      S="$(status_json)"
      read -r m k < <(jf "$S" '"%.2f %s" % min((d["lidar"][k], k) for k in ["front_m","left_m","right_m","back_m"])')
      if python3 -c "import sys; sys.exit(0 if float('${m:-9}') < float('$MIN') else 1)"; then MIN="$m"; WHERE="$k"; fi
      sleep 0.1
    done
    note "$g: sector mínimo $MIN m ($WHERE)"
    if python3 -c "import sys; sys.exit(0 if float('$MIN') < 0.28 else 1)"; then SHADOWED+=("$g→$WHERE $MIN m"); fi
  done
  gesture home >/dev/null
  if [ ${#SHADOWED[@]} -eq 0 ]; then
    ok "Ningún gesto hace que el brazo bloquee el LiDAR."
  else
    bad "El brazo aparece como obstáculo en: ${SHADOWED[*]}. Calibra ARM_SHADOW_MIN_M / ARM_SHADOW_MAX_M / ARM_SHADOW_HALF_ANGLE_DEG."
  fi
  check_manual "Ningún gesto chocó con algo ni acercó el brazo a la torre del LiDAR"
else
  warn "Omití la prueba de gestos."
fi

# ==============================================================================
section "5. Sentido de las ruedas Mecanum"
if clear_area; then
  for spec in "0.10 0 0:hacia ADELANTE" "-0.10 0 0:hacia ATRÁS" "0 0.10 0:de lado a la IZQUIERDA" "0 -0.10 0:de lado a la DERECHA" "0 0 0.4:girando a la IZQUIERDA (antihorario)" "0 0 -0.4:girando a la DERECHA (horario)"; do
    read -r vx vy wz <<< "${spec%%:*}"; label="${spec#*:}"
    R="$(cmd_vel "$vx" "$vy" "$wz" 600)"
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
section "6. Paros"
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

  pause "Ahora presiona Esc (o el botón PARO) en la web de la laptop"
  LATCHED=""
  for _ in $(seq 1 30); do
    [ "$(jf "$(status_json)" 'd["estop_latched"]')" = "True" ] && LATCHED=1 && break
    sleep 0.5
  done
  if [ -n "$LATCHED" ]; then ok "El PARO de la web enclava la E-stop."; else bad "El PARO de la web no enclavó la E-stop en 15 s."; fi
  check_manual "La web muestra el banner «Paro de emergencia activo»"
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
  warn "Omití la prueba de paros."
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
fi
CLIPS="$(find "$ROOT_DIR/web/public/songs/clips" -maxdepth 1 -name '*.mp3' 2>/dev/null | wc -l | tr -d ' ')"
if [ "${CLIPS:-0}" -ge 168 ]; then ok "Hay $CLIPS MP3 de Bumblebee en la laptop."; else bad "Solo hay ${CLIPS:-0} MP3 en web/public/songs/clips (se necesitan 168 para Bumblebee)."; fi
if [ -n "$ROBOT_SSH" ]; then
  RCLIPS="$(ssh "$ROBOT_SSH" "find $ROBOT_REPO/web/public/songs/clips -maxdepth 1 -name '*.mp3' 2>/dev/null | wc -l" 2>/dev/null | tr -d ' ')"
  note "MP3 en el robot (solo hacen falta si Bumblebee corre en el kiosco): ${RCLIPS:-?}"
fi
GH="$(curl -s -m 5 -o /dev/null -w '%{http_code}' https://api.github.com/repos/ykro/rosorin-jsconf)"
if [ "$GH" = "200" ]; then ok "La red del lugar llega a la API de GitHub (Roaster)."; else warn "La API de GitHub respondió $GH: usa los presets del Roaster."; fi
check_manual "La API key de Gemini está cargada en el navegador de la laptop"
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
[ "$FAIL" -eq 0 ]
