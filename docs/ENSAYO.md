# Ensayo con el robot

[`ensayo.sh`](../ensayo.sh) es la lista de revisión del ensayo con el ROSOrin Pro, hecha script. Se corre **en la laptop**, contra el bridge del robot. Revisa solo lo que se puede medir (versión, token, worker, LiDAR, paros) y te guía en lo que necesita tus ojos (orientación del LiDAR, sentido de las ruedas, choques, distancia de frenado). Antes de mover el robot siempre te pide confirmación, y al final deja un resumen y una bitácora con los valores medidos.

Necesitas en la laptop `curl >= 7.55`, `python3` y el token del robot. Node solo se usa para leer la lista de gestos de `gestures.rs` (si falla, el script usa una lista fija). Con `--ssh` también necesitas acceso SSH al robot.

---

## 1. En el robot

```bash
cd <ruta-del-repo>
git pull            # si falla: git fetch origin && git reset --hard origin/main
make build-robot
make robot
```

- `git pull` falla en un clon anterior a la reescritura del historial. En ese caso usa `git fetch origin && git reset --hard origin/main`, que descarta los cambios locales sin commit.
- `make build-robot` recompila el binario de release. El bridge y `ros2_worker.py` se actualizan juntos: un bridge nuevo con un worker viejo marca `connected=false` y bloquea el chasis. `iniciar-robot.sh` usa ese binario, y `ensayo.sh` revisa que esté al día.
- `make robot` levanta el bridge en `0.0.0.0:9000` con token. Si existe el candado de paro de otra app (`~/.openclaw/workspace/ESTOP_LOCK`), se niega a arrancar.
- La primera vez en cada robot (o si cambió el montaje del brazo o del LiDAR), calibra la sombra del brazo: con `make robot` corriendo y 50 cm despejados, corre `make calibrar-sombra` en otra terminal del robot y después reinicia `make robot`. Solo mueve el brazo. Detalles en [`SECURITY.md`](./SECURITY.md#sombra-del-brazo).

## 2. En la laptop

```bash
git pull
./traer-token.sh <usuario>@<IP_DEL_ROBOT>
./run.sh --robot-ip <IP_DEL_ROBOT>
```

Abre la URL que imprime `run.sh` (`http://localhost:3000/?bridge=http://<IP_DEL_ROBOT>:9000#token=<token>`) y carga tu API key de Gemini. No proyectes esa terminal: muestra el token.

En otra terminal de la laptop:

```bash
./ensayo.sh --robot-ip <IP_DEL_ROBOT> --ssh <usuario>@<IP_DEL_ROBOT>
```

`traer-token.sh` y `ensayo.sh` buscan el repo del robot en `~/Desktop/rosorin-jsconf`. Si está en otra ruta, pásala (`./traer-token.sh <usuario>@<IP> <ruta>` y `--robot-repo <ruta>`) o defínela en `ROBOT_REPO`.

## 3. Opciones de `ensayo.sh`

| Opción | Qué hace |
|---|---|
| `--robot-ip <IP>` (o `--ip`) | IP del bridge. Obligatoria, salvo con `--mock`. |
| `--ssh <usuario>@<IP>` | Habilita las revisiones por SSH: commit y binario del robot, `ros2 topic hz /scan` y cuántos MP3 hay en el robot. |
| `--robot-repo <ruta>` | Ruta del repo en el robot (por defecto `~/Desktop/rosorin-jsconf` o `ROBOT_REPO`). |
| `--solo-auto` | Corre solo las revisiones automáticas de la sección 2 y termina. No mueve nada ni pregunta. |
| `--mock` | Usa el bridge local en `127.0.0.1:9000`, para probar el script con `./run.sh --mock`. No lee `.bridge-token` (el mock no usa token) y omite la preparación y la orientación del LiDAR. |
| `--port <P>` | Puerto del bridge (9000 por defecto, o `BRIDGE_PORT`). |
| `--help` / `-h` | Muestra la ayuda. |

El token sale de `BRIDGE_TOKEN` o de `.bridge-token`; sin token, el script se detiene y te sugiere `./traer-token.sh`. Todas las peticiones mandan el token a `curl` por stdin.

## 4. Cómo se usa

- Cada revisión queda como `[OK]`, `[FALLA]` o `[AVISO]`. Las preguntas se contestan con `s` o `n`; `n` cuenta como falla.
- Antes de cada bloque que mueve el robot pregunta: «Área despejada alrededor del robot y mano en el interruptor de encendido. ¿Muevo el robot?». Si contestas `n`, omite ese bloque (en las secciones 4 a 6 lo deja como aviso).
- **Ctrl+C** en cualquier momento manda `POST /stop` (la E-stop queda enclavada) y termina con código 130.
- Al final manda `/stop`, libera la E-stop y lleva el brazo a `home`.

## 5. Qué revisa cada sección

| Sección | Automático | Manual (tú confirmas o haces algo) |
|---|---|---|
| **1. Preparación** | — | Robot en el piso o con 30 cm libres al borde de la mesa (el LiDAR no ve el borde), batería cargada con repuesto, interruptor a tu alcance (con `run.sh` el botón físico de fábrica no actúa), laptop en la Wi-Fi WPA2 propia del robot y la terminal con el token sin proyectar. Se omite con `--solo-auto` o `--mock`. |
| **2. Versión y arranque** | Commit de la laptop (avisa si hay cambios sin commit). Con `--ssh`: mismo commit en el robot y binario de release más nuevo que `backend.rs` y `main.rs`. `GET /health` responde 200, sin token responde 401 y `/status` con token responde 200 (si no, se detiene). Backend (avisa si no es `ros2`), batería y fuente del LiDAR. `connected=true`. Si la E-stop estaba enclavada, la libera con un aviso. `lidar_stale=false`. Con `--ssh`: frecuencia de `/scan`. | — |
| **3. Orientación del LiDAR** | Distancias de los 4 sectores sin obstáculos. Con cada caja, que el sector correcto sea el más cercano y baje de 0.35 m. Con el LiDAR tapado, que se encienda `obstacle_alert`. Se omite con `--mock`. | Poner una caja a unos 20 cm al frente, a la izquierda, a la derecha y atrás; luego tapar el LiDAR con la mano y destaparlo. |
| **4. Sombra del brazo** | Corre los 20 gestos de `gestures.rs` (todos menos `home`), lee `/status` 30 veces durante cada uno y anota el sector mínimo. Falla si algún gesto baja un sector de 0.28 m: es el brazo visto como obstáculo. | Dejar 50 cm libres alrededor y confirmar que ningún gesto chocó ni acercó el brazo a la torre del LiDAR. |
| **5. Ruedas Mecanum** | 6 movimientos de 600 ms: adelante, atrás, de lado a la izquierda y a la derecha (0.10 m/s) y giro antihorario y horario (0.4 rad/s). Falla si la respuesta trae `blocked`. | Confirmar que el robot se movió en el sentido que dice cada pregunta. |
| **6. Paros** | `/stop` a 0.8 s de empezar `victory_spin`: giro en 0 y E-stop enclavada. `cmd_vel` con la E-stop enclavada responde 423. `/estop/release` libera. El PARO de la web enclava la E-stop (espera hasta 15 s) y «Liberar» la libera. Watchdog: tras un `cmd_vel` de 600 ms, el chasis está en 0 al segundo. | Confirmar que el robot paró al instante sin tirón del brazo. Presionar Esc o el botón **PARO** en la web, ver el banner y pulsar «Liberar». Avanzar con la web hacia una caja hasta que el freno la detenga y escribir la distancia de frenado al frente y de lado (en cm; menos de 10 cm da un aviso). Cortar la Wi-Fi de la laptop a media marcha (debe parar en menos de 1 s) y hacer Ctrl+C en el bridge del robot (deben parar los motores). |
| **7. Demos** | Cuenta los MP3 en `web/public/songs/clips` de la laptop (falla con menos de 168). Con `--ssh`, cuenta los del robot (solo hacen falta si Bumblebee corre en el kiosco). Revisa que la red llegue a la API de GitHub (si no, avisa que uses los repos preconfigurados del Roaster). | Props en su lugar. Con `gatekeeper_approve` y `gatekeeper_reject`, la llave cae en la bandeja verde y en la roja; con `point_cloud_run`, `point_gemini_live` y `point_firestore`, el brazo apunta al tótem correcto. API key cargada en el navegador, *barge-in* con el micrófono real y sin falsas interrupciones con la bocina y los servos. |
| **8. Plan B** | Las slides publicadas responden 200 y existe la copia local `web/public/slides/index.html`. | Probaste `./run.sh --mock` en esta laptop y tienes un video de respaldo de cada demo. |

## 6. Bitácora y valores que conviene anotar

La bitácora queda en la raíz del repo de la laptop como `ensayo-AAAAMMDD-HHMM.log` (está en `.gitignore`). Repite todo lo que salió en pantalla, incluido el resumen final con las fallas. El script termina con código 0 si no hubo fallas.

Busca en la bitácora y anota para la charla:

| Valor | Dónde aparece | Para qué sirve |
|---|---|---|
| Frecuencia de `/scan` | `Valor medido: /scan <N> Hz` (sección 2, con `--ssh`) | El bridge exige un scan cada 300 ms. Si la frecuencia baja mucho o fluctúa, verás `lidar_stale` en el escenario. |
| Distancia de frenado | `Valor medido: frenado al frente <N> cm` y `frenado de lado <N> cm` (sección 6) | Cuánto margen real hay antes de tocar una caja. Menos de 10 cm es poco. |
| Gestos con sombra | Líneas `<gesto>: sector mínimo <N> m (<sector>)` y la falla `El brazo aparece como obstáculo en: …` (sección 4) | Qué poses ve el LiDAR como obstáculo y a qué distancia: son los datos para calibrar la sombra del brazo. |
| Sectores con caja y sin obstáculos | Líneas `Sin obstáculos:` y `Con la caja …:` (sección 3) | Confirmar la orientación del `/scan` y la distancia real a lo que rodea el escenario. |

## 7. Si algo falla

| Falla | Qué hacer |
|---|---|
| Aviso «El LiDAR viene de 'none'» o de 'mock' | El bridge no está usando el backend `ros2`: cayó a mock en la autodetección o corre con `serial`. Levanta `make robot` en el robot y revisa que el log diga `backend ros2`. |
| El robot está en otro commit o su binario no está recompilado | En el robot: `git pull` (o `git fetch origin && git reset --hard origin/main`), `make build-robot` y reinicia `make robot`. |
| `connected=false` | El worker no contesta el *heartbeat*. Casi siempre son bridge y worker de versiones distintas: actualiza los dos como en la fila anterior. Si persiste, revisa la terminal de `make robot` (`Driver sin respuesta`) y que nada más esté usando `/dev/rrc`. |
| `GET /status` con token no responde 200 | El token de la laptop no es el del robot. Vuelve a correr `./traer-token.sh`. |
| Sin token no responde 401 | El bridge corre sin token. En el robot usa `make robot`, que siempre lo exige. |
| `lidar_stale=true` o no se pudo medir `/scan` | No llegan scans. Revisa el driver del LiDAR en el robot con `ros2 topic hz /scan`. |
| La caja baja otro sector (sección 3) | El `/scan` está rotado o invertido respecto a REP-103 (ángulo 0 al frente, positivo a la izquierda). Si frente y atrás están cambiados, levanta el bridge con `LIDAR_ANGLE_OFFSET_DEG=180 make robot`; si izquierda y derecha están cambiadas, con `LIDAR_FLIP=1 make robot` (se pueden combinar, y otro ángulo sirve para montajes girados 90°). Repite la sección 3 y corre `make calibrar-sombra` de nuevo: con la orientación mal, el freno protege el lado equivocado. |
| Gestos con el brazo visto como obstáculo (sección 4) | Calibra la sombra del brazo en el robot: con `make robot` corriendo, `make calibrar-sombra`, reinicia `make robot` y repite la sección 4. Al arrancar, el worker escribe en la terminal la banda que usa y de dónde salió. Si prefieres fijarla a mano, pásala al levantar el bridge, por ejemplo `ARM_SHADOW_MIN_M=0.07 ARM_SHADOW_MAX_M=0.11 ARM_SHADOW_HALF_ANGLE_DEG=25 make robot` (el entorno gana sobre `arm-shadow.json`). Detalles en [`SECURITY.md`](./SECURITY.md#sombra-del-brazo). |
| Un sector marca `0.0` sin nada enfrente | Es un sector ciego: menos del 25 % de sus rayos son utilizables. Limpia o destapa la ventana del LiDAR. Si sigue igual con el escenario despejado, tu driver quizá reporta el espacio vacío como `0` o `NaN` en vez de `+inf`: `make calibrar-sombra` lo avisa al contar los rayos. Como último recurso, `LIDAR_MIN_VALID_FRACTION=0 make robot` apaga la revisión, a conciencia: un LiDAR tapado ya no bloquearía el chasis. |
| Un movimiento de la sección 5 sale con `blocked` | `braked`: hay algo a menos de 0.28 m en esa dirección (o el brazo). `lidar_stale` o `worker_dead`: ver las filas de arriba. |
| El robot se mueve en otro sentido del que dice la pregunta (sección 5) | No sigas con las demos. El código asume el cableado de fábrica: motores 3 y 4 (lado derecho) montados invertidos (`mecanum_ik` en `protocol.rs` y `ros2_worker.py`). Revisa el orden y la polaridad de los motores. |
| El PARO de la web no enclava la E-stop | Revisa que la URL de la web tenga el bridge del robot y el token (la píldora de la barra superior muestra el host). Abre otra vez la URL que imprimió `run.sh`. |
| Faltan MP3 | Coloca los `<id>.mp3` en `web/public/songs/clips/` de la laptop. No van en git. |

Si cerraste `run.sh` en la laptop durante el ensayo, mandó `/stop` al robot: libera la E-stop con «Liberar» o `make release` en el robot antes de seguir.
