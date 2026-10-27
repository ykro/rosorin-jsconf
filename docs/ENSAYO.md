# Ensayo con el robot

[`ensayo.sh`](../ensayo.sh) lleva el ensayo con el ROSOrin Pro de punta a punta, con un solo comando en cada lado: `./ensayo.sh --robot` en el robot deja levantados el bridge y la web, y `./ensayo.sh --laptop --ip <IP>` en la laptop trae el token, abre la web del robot en Chrome y corre la guía. Con `--laptop-server` en los dos lados, la web corre en la laptop como antes. La guía revisa solo lo que se puede medir (versión, token, worker, LiDAR, STOP) y te guía en lo que necesita tus ojos (orientación del LiDAR, sentido de las ruedas, choques, distancia de frenado). Antes de mover el robot siempre te pide confirmación, y al final deja un resumen y una bitácora con los valores medidos.

Necesitas en la laptop `curl >= 7.55`, `python3` y acceso SSH al robot (`ubuntu@<IP>` por defecto; para no escribir la contraseña cada vez, autoriza tu llave con `ssh-copy-id ubuntu@<IP>`). Node solo se usa para leer la lista de gestos de `gestures.rs` (si falla, el script usa una lista fija). Para abrir la web del robot hace falta Google Chrome o Chromium; sin ellos, el script cae a `--laptop-server`.

---

## 1. En el robot

```bash
cd ~/Desktop/rosorin-jsconf
./ensayo.sh --robot
```

En orden:

1. **Red.** Espera a que haya Wi-Fi («Aún no hay conexión Wi-Fi. Reviso cada 2 s (Ctrl+C para salir)...») y luego imprime la red, la IP y el comando exacto para la laptop:

   ```
   ================================================================
    Wi-Fi conectada : DunderMifflin (wlan0)
    IP del robot    : 192.168.0.8
    Web             : http://192.168.0.8:3000 (la abre la laptop en Chrome)
    En la laptop    : ./ensayo.sh --laptop --ip 192.168.0.8
   ================================================================
   ```

   Si tu usuario no es `ubuntu` o el repo no está en `~/Desktop/rosorin-jsconf`, el comando ya trae `--ssh` y `--robot-repo` (y `--laptop-server` si lo usaste). Sin ninguna interfaz Wi-Fi (robot con cable) usa la primera IP de la máquina.
2. **Candado y sudo.** Se niega a seguir si existe el candado de STOP de otra app (`~/.openclaw/workspace/ESTOP_LOCK`) y pide `sudo` una vez (`run.sh` detiene servicios de fábrica y, en segundo plano, no puede pedirla).
3. **Repo.** `git fetch origin` y avance *fast-forward* a `origin/main`. Sin internet sigue con el commit actual. Si el repo no avanza en limpio (un clon anterior a la reescritura del historial o cambios locales), te muestra los cambios y pregunta antes de correr `git reset --hard origin/main`; si dices que no, sigue y la guía marcará que el robot no tiene el commit de la laptop.
4. **Compilación.** `make build-robot`. El bridge y `ros2_worker.py` se actualizan juntos: un bridge nuevo con un worker viejo marca `connected=false` y bloquea el chasis.
5. **Sombra del brazo.** Si no existe `robot-bridge/arm-shadow.json`, si se calibró sin registrar la orientación del LiDAR o con otra distinta de la actual (o con `--calibrar`), ofrece calibrarla: levanta el bridge en segundo plano, corre `make calibrar-sombra` (pide 50 cm despejados y mueve solo el brazo) y lo apaga. Detalles en [`SECURITY.md`](./SECURITY.md#sombra-del-brazo).
6. **Web.** Compila la web estática (`npm ci` si cambió `package-lock.json` y `npm run build` → `web/out`) solo si cambió `web/` desde el último build; la primera vez tarda unos 2–3 min en el Jetson. El bundle no lleva la clave de Gemini ni el modo ligero: se sirve a la LAN y el 3D lo dibuja el navegador de la laptop. La sirve un servidor estático en Python en `0.0.0.0:3000` (también sirve `web/public`, así los MP3 que copia la laptop después del build quedan disponibles). Sin Node en el robot, sigue sin web y te dice que uses `--laptop-server`. Con `--laptop-server` se salta este paso.
7. **Bridge.** Imprime otra vez la IP y queda corriendo `./run.sh --bridge-only` (lo mismo que `make robot`): bridge en `0.0.0.0:9000` con token. Ctrl+C detiene el bridge y la web y enclava la E-stop.

`run.sh` detiene `start_app_node.service`, el bringup completo de Hiwonder, para liberar `/dev/rrc`. Ese servicio también lanzaba el LiDAR y la cámara, así que `run.sh` vuelve a levantar solo `peripherals lidar.launch.py` y `depth_camera.launch.py` (si ya corren, no los duplica) y los apaga al salir.

Si prefieres los pasos a mano: `git pull` (o `git fetch origin && git reset --hard origin/main`), `make build-robot`, `make robot` y, con `make robot` corriendo, `make calibrar-sombra` en otra terminal (después reinicia `make robot`).

## 2. En la laptop

```bash
./ensayo.sh --laptop --ip <IP_DEL_ROBOT>
```

En orden:

1. Avanza la laptop a `origin/main` (*fast-forward*) y avisa si tiene commits sin push, porque el robot no los verá con `git pull`.
2. Espera a que responda el bridge del robot en `http://<IP>:9000/health` (mientras tanto, en el robot debe estar corriendo `./ensayo.sh --robot`).
3. Trae el token con `./traer-token.sh ubuntu@<IP>`. Si ya tienes `.bridge-token` y el bridge lo acepta, no lo vuelve a copiar.
4. Copia al robot los MP3 de Bumblebee (`web/public/songs/clips/*.mp3`, que no van en git) con `rsync`, y ahí se quedan. Si la carpeta ya existe, dice cuántos faltan y solo viajan los que faltan o cambiaron; nunca borra nada en el robot.
5. Espera a que responda la web del robot en `http://<IP>:3000` y la abre en Chrome con el token: `http://<IP>:3000/?bridge=http://<IP>:9000#token=<token>`. Si `rosorin_gemini_key` encuentra la clave de Gemini en un `.env`, la agrega al fragmento (`&gemini_key=…`) y la web ya no la pide. El token nunca aparece en la terminal ni en los argumentos de un proceso: Chrome abre una página local (permisos 600) que redirige.
   - **Micrófono.** El navegador solo da el micrófono en un contexto seguro (HTTPS o `localhost`) y `http://<IP>:3000` no lo es. Por eso el script abre Chrome con `--unsafely-treat-insecure-origin-as-secure=http://<IP>:3000`, que trata como seguro solo ese origen. Chrome solo respeta esa bandera con un perfil propio (`--user-data-dir`): usa `~/.cache/rosorin-chrome` (otro con `ROSORIN_CHROME_PROFILE`), que persiste el token y la clave de Gemini entre corridas. Chrome muestra un aviso de «bandera no admitida»: es esa.
6. Corre la guía con las revisiones por SSH activadas (`--ssh ubuntu@<IP>`).
7. Al terminar, en la laptop no queda nada corriendo: el bridge y la web siguen en el robot hasta que hagas Ctrl+C allá.

Con `--laptop-server` (en los dos lados: el robot queda solo con el bridge), el paso 5 cambia: levanta la web con `./run.sh --robot-ip <IP>` en segundo plano (log en un directorio temporal privado) y la abre en tu navegador por defecto en `http://localhost:3000/?bridge=http://<IP>:9000#token=<token>`, que ya es contexto seguro. Al terminar la guía, la web sigue abierta para las demos hasta que hagas **Ctrl+C**, que cierra `run.sh`, y este manda `/stop` al bridge (la E-stop queda enclavada). Con `--solo-auto`, o sin terminal interactiva, la cierra en cuanto termina. Úsalo si el Jetson va justo de recursos, si no tienes Chrome o si quieres el servidor de desarrollo.

`--ip=<IP>` también funciona. Si no pasas la IP, la pregunta. El usuario SSH es `ubuntu` (o `ROBOT_USER`); otro se pasa con `--ssh <usuario>@<IP>`. Si el repo del robot no está en `~/Desktop/rosorin-jsconf`, pásalo con `--robot-repo <ruta>` o defínelo en `ROBOT_REPO`.

Para probar el script sin robot: `./ensayo.sh --laptop --mock` levanta `./run.sh --mock` (bridge, gemelo y web locales, como `--laptop-server`) y corre la guía contra él.

Si ya tienes bridge y web levantados a mano, la guía sola sigue disponible: `./ensayo.sh --robot-ip <IP_DEL_ROBOT> --ssh <usuario>@<IP_DEL_ROBOT>`.

## Demo (el día de la charla)

[`demo.sh`](../demo.sh) es lo mismo sin la guía: un comando en cada lado.

```bash
./demo.sh --robot                          # en el robot
./demo.sh --laptop --ip <IP_DEL_ROBOT>     # en la laptop
# o, con la web en la laptop:
./demo.sh --robot --laptop-server
./demo.sh --laptop --ip <IP_DEL_ROBOT> --laptop-server
```

En el robot hace los pasos 1 a 4, 6 y 7 de arriba. La sombra del brazo no la calibra: si falta o está vieja, solo avisa (se calibra en el ensayo). El comando que imprime para la laptop es `./demo.sh --laptop --ip <IP>`. En la laptop hace los pasos 1 a 5 (incluida la copia de los MP3), abre la web del robot en Chrome y termina: el bridge y la web siguen en el robot, y Ctrl+C allá los detiene. Con `--laptop-server` deja la web de la laptop abierta hasta **Ctrl+C**, que manda `/stop` al bridge. `./demo.sh --laptop --mock` levanta el gemelo local.

## 3. Opciones de `ensayo.sh`

| Opción | Qué hace |
|---|---|
| `--robot` | En el robot: espera la Wi-Fi e imprime la IP, actualiza el repo, compila, ofrece calibrar la sombra y levanta el bridge y la web en `:3000` (sección 1). |
| `--laptop` | En la laptop: actualiza, trae el token, copia los MP3, abre la web del robot en Chrome (o levanta el gemelo con `--mock`) y corre la guía (sección 2). |
| `--laptop-server` | En los dos lados: la web corre en la laptop (`./run.sh --robot-ip`, en `localhost`) y el robot levanta solo el bridge. |
| `--robot-ip <IP>` (o `--ip`, `--ip=<IP>`) | IP del bridge. Sin `--laptop` ni `--mock` es obligatoria (solo la guía). |
| `--ssh <usuario>@<IP>` | Habilita las revisiones por SSH: commit y binario del robot, `ros2 topic hz /scan` y cuántos MP3 hay en el robot. En `--laptop` vale `ubuntu@<IP>` por defecto (o `ROBOT_USER`). |
| `--robot-repo <ruta>` | Ruta del repo en el robot (por defecto `~/Desktop/rosorin-jsconf` o `ROBOT_REPO`). |
| `--calibrar` | Con `--robot`: calibra la sombra del brazo aunque ya exista `arm-shadow.json`. |
| `--solo-auto` | Corre solo las revisiones automáticas de la sección 2 de la guía y termina. No mueve nada ni pregunta. |
| `--mock` | Usa el bridge local en `127.0.0.1:9000`. Con `--laptop` lo levanta (`./run.sh --mock`); sin `--laptop`, espera que ya esté corriendo. No lee `.bridge-token` (el mock no usa token) y omite la preparación y la orientación del LiDAR. |
| `--port <P>` | Puerto del bridge (9000 por defecto, o `BRIDGE_PORT`). La web usa `WEB_PORT` (3000 por defecto, en el robot o en la laptop). |
| `--help` / `-h` | Muestra la ayuda. |

En la guía, el token sale de `BRIDGE_TOKEN` o de `.bridge-token`. Sin token, el script se detiene y te sugiere `./ensayo.sh --laptop --ip <IP>` o `./traer-token.sh`. Todas las peticiones mandan el token a `curl` por stdin.

## 4. Cómo se usa

- Cada revisión queda como `[OK]`, `[FALLA]` o `[AVISO]`. Las preguntas se contestan con `s` o `n`; `n` cuenta como falla.
- Antes de cada bloque que mueve el robot pregunta: «Área despejada alrededor del robot y mano en el interruptor de encendido. ¿Muevo el robot?». Si contestas `n`, omite ese bloque (en las secciones 4 a 6 lo deja como aviso).
- **Ctrl+C** en cualquier momento manda `POST /stop` (la E-stop queda enclavada) y termina con código 130. Con `--laptop-server` también cierra la web de la laptop.
- Al final manda `/stop`, libera la E-stop y lleva el brazo a `home`.

## 5. Qué revisa cada sección

| Sección | Automático | Manual (tú confirmas o haces algo) |
|---|---|---|
| **1. Preparación** | — | Robot en el piso o con 30 cm libres al borde de la mesa (el LiDAR no ve el borde), batería cargada con repuesto, interruptor a tu alcance (con `run.sh` el botón físico de fábrica no actúa) y la terminal con el token sin proyectar. Automático: que la laptop llegue al bridge del robot (misma Wi-Fi; una red de invitados con aislamiento de clientes no deja que se vean). Se omite con `--solo-auto` o `--mock`. |
| **2. Versión y arranque** | Commit de la laptop (avisa si hay cambios sin commit). Con `--ssh` (siempre en `--laptop` contra el robot): mismo commit en el robot y binario de release más nuevo que `robot-bridge/src`, `Cargo.toml` y `Cargo.lock`. `GET /health` responde 200; en `--laptop` sin `--laptop-server`, la web del robot responde en `/robot`. Sin token responde 401 y `/status` con token responde 200 (si no, se detiene). Backend (avisa si no es `ros2`), batería y fuente del LiDAR. `connected=true`. Si la E-stop estaba enclavada, la libera con un aviso. `lidar_stale=false`. Con `--ssh`: frecuencia de `/scan`. | — |
| **3. Orientación del LiDAR** | Distancias de los 4 sectores sin obstáculos. Con cada objeto, que el sector correcto sea el más cercano y baje de 0.35 m. Un sector sin LiDAR (`lidar.uncovered`; en el ROSOrin Pro, atrás, que tapan el chasis y los cables) no se prueba y queda como aviso. Un sector ciego (tiene rayos pero ninguno sirve: ventana tapada o sucia) es falla. Con el LiDAR tapado, que se encienda `obstacle_alert`. Se omite con `--mock`. | Poner una caja o botella (de al menos 15 cm de alto, para que cruce el plano del LiDAR) a unos 20 cm al frente, a la izquierda y a la derecha (y atrás solo si ese sector tiene LiDAR); luego tapar el LiDAR con la mano y destaparlo. |
| **4. Sombra del brazo** | Corre los 20 gestos de `gestures.rs` (todos menos `home`) y lee `/status` a ~10 Hz durante 2 s con cada uno (un solo proceso por gesto), sin contar los sectores en 0.0 (ciegos o sin LiDAR). Falla si un gesto baja un sector de 0.28 m: es el brazo visto como obstáculo. En los gestos que mueven el chasis solo cuenta el frente; en los otros sectores es el robot acercándose a algo («movió el chasis, no cuenta como sombra»). | Dejar 50 cm libres alrededor (los gestos también mueven el chasis) y confirmar que ningún gesto chocó ni acercó el brazo a la torre del LiDAR. |
| **5. Ruedas Mecanum** | 6 movimientos: adelante y de lado a la izquierda y a la derecha (0.10 m/s, 600 ms), atrás despacio (0.05 m/s, 500 ms ≈ 2.5 cm, con una confirmación aparte porque el LiDAR no ve atrás) y giro antihorario y horario (0.4 rad/s). Falla si la respuesta trae `blocked`. Si atrás no tiene LiDAR, antes avisa «Atrás no frena»: deja libre detrás del robot y nunca lo pruebes en una mesa. | Confirmar que el robot se movió en el sentido que dice cada pregunta. |
| **6. STOP** | `/stop` a 0.8 s de empezar `victory_spin`: giro en 0 y E-stop enclavada. `cmd_vel` con la E-stop enclavada responde 423. `/estop/release` libera. El STOP de la web enclava la E-stop (espera hasta 15 s) y «Liberar» la libera. Watchdog: tras un `cmd_vel` de 600 ms, el chasis está en 0 al segundo. | Confirmar que el robot paró al instante sin tirón del brazo. Presionar Esc o el botón **STOP** en la web, ver el banner y pulsar «Liberar». Avanzar con la web hacia una caja hasta que el freno la detenga y escribir la distancia de frenado al frente y de lado (en cm; menos de 10 cm da un aviso). Cortar la Wi-Fi de la laptop a media marcha (debe parar en menos de 1 s) y hacer Ctrl+C en el bridge del robot (deben parar los motores). |
| **7. Demos** | Cuenta los MP3 en `web/public/songs/clips` de la laptop (falla con menos de 168). Con `--ssh`, cuenta los del robot: con la web en el robot (sin `--laptop-server`) falla con menos de 168, porque Bumblebee los baja de ahí. Revisa que la red llegue a la API de GitHub (si no, avisa que uses los repos preconfigurados del Roaster). | Props en su lugar. Con `gatekeeper_approve` y `gatekeeper_reject`, la llave cae en la bandeja verde y en la roja; con `point_cloud_run`, `point_gemini_live` y `point_firestore`, el brazo apunta al tótem correcto. API key cargada en el navegador, *barge-in* con el micrófono real y sin falsas interrupciones con la bocina y los servos. |
| **8. Plan B** | Las slides publicadas responden 200 y existe la copia local `web/public/slides/index.html`. | Probaste `./run.sh --mock` en esta laptop y tienes un video de respaldo de cada demo. |

## 6. Bitácora y valores que conviene anotar

La bitácora queda en la raíz del repo de la laptop como `ensayo-AAAAMMDD-HHMM.log` (está en `.gitignore`). Repite todo lo que salió en pantalla, incluido el resumen final con las fallas. El script termina con código 0 si no hubo fallas.

Busca en la bitácora y anota para la charla:

| Valor | Dónde aparece | Para qué sirve |
|---|---|---|
| Frecuencia de `/scan` | `Valor medido: /scan <N> Hz` (sección 2, con `--ssh`) | El bridge exige un scan cada 300 ms. Si la frecuencia baja mucho o fluctúa, verás `lidar_stale` en el escenario. |
| Distancia de frenado | `Valor medido: frenado al frente <N> cm` y `frenado de lado <N> cm` (sección 6) | Cuánto margen real hay antes de tocar una caja. Menos de 10 cm es poco. |
| Gestos con sombra | Líneas `<gesto>: sector mínimo <N> m (<sector>)` y la falla `El brazo aparece como obstáculo en: …` (sección 4) | Qué poses ve el LiDAR como obstáculo y a qué distancia: son los datos para calibrar la sombra del brazo. |
| Sectores con objeto y sin obstáculos | Líneas `Sin obstáculos:` y `Con el objeto …:` (sección 3) | Confirmar la orientación del `/scan` y la distancia real a lo que rodea el escenario. |

## 7. Si algo falla

| Falla | Qué hacer |
|---|---|
| Aviso «El LiDAR viene de 'none'» o de 'mock' | El bridge no está usando el backend `ros2`: cayó a mock en la autodetección o corre con `serial`. Levanta `make robot` en el robot y revisa que el log diga `backend ros2`. |
| El robot está en otro commit o su binario no está recompilado | Vuelve a correr `./ensayo.sh --robot` en el robot (actualiza, compila y levanta el bridge). A mano: `git pull` (o `git fetch origin && git reset --hard origin/main`), `make build-robot` y reinicia `make robot`. Si la laptop avisó de commits sin push, súbelos primero. |
| `connected=false` | El worker no contesta el *heartbeat*. Casi siempre son bridge y worker de versiones distintas: actualiza los dos como en la fila anterior. Si persiste, revisa la terminal de `make robot` (`Driver sin respuesta`) y que nada más esté usando `/dev/rrc`. |
| `GET /status` con token no responde 200 | El token de la laptop no es el del robot. Vuelve a correr `./traer-token.sh <usuario>@<IP>` (o `--force` para traerlo aunque el bridge no responda). |
| Sin token no responde 401 | El bridge corre sin token. En el robot usa `make robot`, que siempre lo exige. |
| `lidar_stale=true` o no se pudo medir `/scan` | No llegan scans. Al arrancar, `run.sh` detiene `start_app_node.service` (que lanzaba el LiDAR) y vuelve a levantar `peripherals lidar.launch.py`: busca en su salida «Levantando lidar.launch.py (log en …)» y revisa ese log. En el robot, `ros2 topic hz /scan` dice si publica; recuerda que ahí ROS usa `ROS_LOCALHOST_ONLY=1`. |
| El objeto baja otro sector (sección 3) | El `/scan` está rotado o invertido respecto a REP-103 (ángulo 0 al frente, positivo a la izquierda). Guarda la orientación de ese robot en `robot-bridge/lidar-mount.json` (fuera de git), por ejemplo `{"offset_deg": 180, "flip": false}` si frente y atrás están cambiados o `"flip": true` si izquierda y derecha están cambiadas (se pueden combinar, y otro ángulo sirve para montajes girados 90°). `make calibrar-sombra` ofrece escribirlo cuando detecta un LiDAR girado 180°. Para probar sin el archivo: `LIDAR_ANGLE_OFFSET_DEG=180 make robot` o `LIDAR_FLIP=1 make robot` (el entorno gana). Reinicia `make robot`, repite la sección 3 y corre `make calibrar-sombra` de nuevo: con la orientación mal, el freno protege el lado equivocado. |
| Gestos con el brazo visto como obstáculo (sección 4) | Calibra la sombra del brazo en el robot: `./ensayo.sh --robot --calibrar`, o a mano con `make robot` corriendo, `make calibrar-sombra` y reiniciar `make robot`. Repite la sección 4. Al arrancar, el worker escribe en la terminal la banda que usa y de dónde salió. Si prefieres fijarla a mano, pásala al levantar el bridge, por ejemplo `ARM_SHADOW_MIN_M=0.07 ARM_SHADOW_MAX_M=0.11 ARM_SHADOW_HALF_ANGLE_DEG=25 make robot` (el entorno gana sobre `arm-shadow.json`). Detalles en [`SECURITY.md`](./SECURITY.md#sombra-del-brazo). |
| `make calibrar-sombra` dice «No llega /scan en 10 s» | Lee la línea que sigue: si no ve ningún publicador de `/scan`, el driver no corre o usa otro `ROS_DOMAIN_ID` o `ROS_LOCALHOST_ONLY`; si lo ve pero no llegan mensajes, revisa el cable y la alimentación del LiDAR. |
| `make calibrar-sombra` dice que `/scan` solo cubre una parte del frente | La orientación está mal (típico de un LiDAR girado 180° cuyo driver recorta la parte de atrás). Contesta `s` para guardar el offset en `lidar-mount.json` y confirma después el frente con la caja de la sección 3. |
| Atrás marca «sin LiDAR» | Es lo normal en el ROSOrin Pro: el chasis y los cables tapan la parte de atrás (`lidar.uncovered: ["back"]`). Hacia atrás el robot no frena; mira detrás antes de retroceder. |
| Un sector marca `0.0` sin nada enfrente | Si no está en `uncovered`, es un sector ciego: menos del 25 % de sus rayos son utilizables. Limpia o destapa la ventana del LiDAR. Si sigue igual con el escenario despejado, tu driver quizá reporta el espacio vacío como `0` o `NaN` en vez de `+inf`: `make calibrar-sombra` lo avisa al contar los rayos. Como último recurso, `LIDAR_MIN_VALID_FRACTION=0 make robot` apaga la revisión, a conciencia: un LiDAR tapado ya no bloquearía el chasis. |
| Un movimiento de la sección 5 sale con `blocked` | `braked`: hay algo a menos de 0.28 m en esa dirección (o el brazo). `lidar_stale` o `worker_dead`: ver las filas de arriba. |
| El robot se mueve en otro sentido del que dice la pregunta (sección 5) | No sigas con las demos. El código asume el cableado de fábrica: motores 3 y 4 (lado derecho) montados invertidos (`mecanum_ik` en `protocol.rs` y `ros2_worker.py`). Revisa el orden y la polaridad de los motores. |
| El STOP de la web no enclava la E-stop | Revisa que la URL de la web tenga el bridge del robot y el token (la píldora de la barra superior muestra el host). Vuelve a correr `./ensayo.sh --laptop --ip <IP>`: reabre la web con el token. Con `--laptop-server`, la URL con el token también está en el `web.log` del directorio temporal que imprime el script (no la proyectes). |
| La web del robot no abre o Chrome no da el micrófono | En el robot, `./ensayo.sh --robot` sin `--laptop-server` debe decir «Levanto el bridge (make robot) con la web en :3000». La primera vez compila unos minutos; si no hay Node en el robot, sigue sin web. Chrome solo concede el micrófono a `http://<IP>:3000` con el perfil propio del script (`~/.cache/rosorin-chrome`): si abriste la URL a mano en tu Chrome normal, ciérrala y vuelve a correr `./ensayo.sh --laptop`. Si nada de eso funciona, usa `--laptop-server` en los dos lados. |
| Faltan MP3 | Coloca los `<id>.mp3` en `web/public/songs/clips/` de la laptop (no van en git). `./ensayo.sh --laptop` y `./demo.sh --laptop` los copian al robot. |

Si cerraste `run.sh` en la laptop durante el ensayo (con `--laptop-server`, también el Ctrl+C final de `--laptop`, que lo cierra), mandó `/stop` al robot: libera la E-stop con «Liberar» o `make release` en el robot antes de seguir.
