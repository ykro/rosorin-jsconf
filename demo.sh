#!/usr/bin/env bash
# ==============================================================================
# demo.sh — Levanta la charla con un solo comando en cada lado. Es ensayo.sh sin la guía.
#
# Uso:
#   ./demo.sh --robot               # EN EL ROBOT: espera la Wi-Fi e imprime la IP, actualiza,
#                                   # compila y levanta el bridge y la web :3000 (Ctrl+C los detiene)
#   ./demo.sh --laptop --ip <IP>    # EN LA LAPTOP: trae el token, copia los MP3 y abre la web del
#                                   # robot en Chrome con micrófono; no deja nada corriendo aquí
#   ... --laptop-server             # en los dos lados: la web corre en la laptop (localhost);
#                                   # Ctrl+C en la laptop la cierra y manda /stop
#   ./demo.sh --laptop --mock       # contra el gemelo local
#
# Acepta las mismas opciones que ensayo.sh (--ssh, --robot-repo, --port). La calibración de la sombra
# del brazo se hace en el ensayo: aquí solo se avisa si falta.
# ==============================================================================
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ensayo.sh" --demo "$@"
