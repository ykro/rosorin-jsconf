# Seguridad y operación

El robot se mueve de verdad, así que `robot-bridge` aplica estas reglas. El contrato exacto de cada respuesta (códigos, cuerpos JSON y orden de los filtros) está en [`API.md`](./API.md).

## Token

- Por defecto el bridge escucha en `127.0.0.1`. Si escucha en otra dirección y no hay `BRIDGE_TOKEN`, sale con código `2` (salvo con `--insecure-no-token`, que no recomendamos).
- El token va en `x-bridge-token` o `Authorization: Bearer`. `?token=` solo se acepta en `/ws`. `GET /health` y los preflight `OPTIONS` no lo piden.
- En el robot, `run.sh` lo genera si falta y lo guarda en `.bridge-token` con permisos `600`. Para llevarlo a tu laptop corre `./traer-token.sh <usuario>@<IP_DEL_ROBOT>`, que lo lee por SSH y lo guarda en tu `.bridge-token` con permisos `600`; los detalles están en [`ONBOARDING.md`](./ONBOARDING.md#paso-3-traer-el-token-a-tu-laptop).
- `make reset`, `make release`, el `/stop` de salida de `run.sh` y `ensayo.sh` mandan el token a `curl` por stdin (`-H @-`, requiere `curl >= 7.55`): no aparece en `ps` ni en `make -n`.

### El token en la web

- Llega en el fragmento de la URL, `#token=<t>`, que es lo que imprime `run.sh` y lo que abre el kiosco (`/face#token=<t>`). El fragmento no llega al servidor de Next ni a sus logs. `?token=<t>` sigue funcionando.
- La web lo guarda en `localStorage` como `ROSORIN_BRIDGE_TOKEN` y lo quita de la barra de direcciones. `#token=reset` (o `?token=reset`) lo borra. También se puede pegar en el panel que abre la píldora del robot en la barra superior.
- Si cambias el bridge a otro host (con `?bridge=` o desde el panel), la web borra el token guardado para no mandarlo a un host para el que no se emitió, salvo que la misma URL traiga uno nuevo. El panel muestra el host del bridge y avisa cuando borró el token.
- **Nunca va en una variable `NEXT_PUBLIC_*`**, porque esas terminan en el bundle público.

## Origen y host

- Se aceptan orígenes de loopback, `localhost`, `jsconfmx26.web.app`, `jsconfmx26.firebaseapp.com` y los que agregues en `BRIDGE_ALLOWED_ORIGINS`.
- Las IPs privadas (`10/8`, `172.16/12`, `192.168/16`) solo se aceptan como origen si el bridge tiene token o escucha fuera de loopback. Un bridge en `127.0.0.1` sin token (`./run.sh --mock`) las rechaza con `403`: abre la web en `http://localhost:3000`, no en la IP de tu laptop. El log de arranque lo dice: `orígenes IP privadas=sí|no`.
- El header `Host` debe ser una IP, `localhost` o un nombre de `BRIDGE_ALLOWED_HOSTS` (por ejemplo `rosorin.local`).

## Límite de peticiones

30 POST por segundo con ráfaga de 60, global. `/stop` y `/estop/release` no cuentan.

## Paro de emergencia enclavado

`POST /stop` detiene motores, congela el brazo donde está y bloquea todo movimiento con `423 estop_latched` hasta `POST /estop/release`. Se dispara con:

- El botón **PARO** fijo en la barra superior de la web (en `/`, `/demo`, `/robot` y las 4 demos, siempre que el bridge esté habilitado; en `localhost` lo está por defecto), o la tecla **Escape**. Escape no actúa mientras escribes en un campo de texto y, si el panel del robot está abierto, primero lo cierra. Funciona aunque el WebSocket de telemetría esté caído, porque manda el `POST /stop` directo.
- El botón **PARO** de `/face`, que aparece siempre que el bridge está habilitado y la E-stop no está enclavada, aunque el WebSocket esté caído.
- El botón «Paro de emergencia» del panel del robot, `make reset` o `curl`.

Se libera con «Liberar» en el banner, `make release` o `POST /estop/release`.

El bridge también enclava la E-stop al apagarse (SIGINT o SIGTERM): pone el chasis en 0 y ninguna conexión que siga abierta puede mover el robot mientras el proceso termina.

## Worker que no responde

Con `ros2`, el bridge le manda al worker `{"op":"ping","seq":N}` cada 100 ms y el worker contesta `{"event":"pong","seq":N}` desde el mismo hilo que ejecuta los comandos. Si el último *pong* tiene más de 400 ms, o una escritura al worker o al puerto serie lleva más de 300 ms atascada, `connected` pasa a `false` y el chasis queda bloqueado; se recupera solo cuando el worker vuelve a contestar. Las respuestas de acción traen `blocked: "worker_dead"` y la web las trata como error.

El bridge y `ros2_worker.py` se actualizan juntos. Un worker anterior al *heartbeat* nunca contesta el ping, así que un bridge nuevo con ese worker queda en `connected=false` con el chasis bloqueado. En el robot, después de `git pull`, corre `make build-robot` antes de `make robot`.

## LiDAR que falla cerrado

- Con `ros2`, si no llega un scan en más de 300 ms o el worker muere, el chasis queda bloqueado (`lidar_stale: true`).
- Al arrancar, antes del primer scan, los 4 sectores valen `0.0` y `obstacle_alert` es `true`.
- **Cómo lee cada rayo** (REP 117). Un valor finito dentro de `[range_min, range_max]` es un eco. `+inf` o un valor mayor que `range_max` es espacio libre («nada dentro del alcance»), así que un escenario abierto se reporta abierto (4.0 m). `NaN`, `-inf`, `0` o un valor menor que `range_min` son rayos inválidos: el sensor vio algo demasiado cerca o falló (ventana tapada o sucia).
- **Sector ciego.** Si en un sector menos de `LIDAR_MIN_VALID_FRACTION` (0.25 por defecto) de los rayos es utilizable (eco o espacio libre), el worker lo reporta en `0.0` y el bridge lo trata como obstáculo: bloquea el avance hacia ese lado y limita `|wz|` a 0.3 rad/s. Así, un LiDAR tapado o sucio bloquea el chasis. Con `LIDAR_MIN_VALID_FRACTION=0` la revisión se apaga y el worker lo avisa en stderr.
- **Orientación.** El worker asume REP-103 (ángulo 0 al frente, positivo a la izquierda). Si el driver o el montaje no coinciden, `LIDAR_ANGLE_OFFSET_DEG` (por ejemplo 180) y `LIDAR_FLIP=1` corrigen el scan antes de calcular los sectores; la sección 3 de [`ensayo.sh`](./ENSAYO.md) dice cuál hace falta.
- **Escenario abierto.** Un frente con más de 12 m vacíos se ve abierto (4.0 m) y no bloquea. El riesgo es el de cualquier LiDAR 2D: una superficie negra mate que no devuelve eco también se ve como espacio libre, así que no confíes en el freno frente a telas o mamparas negras.
- **Drivers que no siguen REP 117.** Si tu driver reporta el espacio vacío como `0` o `NaN` en vez de `+inf`, los sectores abiertos se verán ciegos. `make calibrar-sombra` cuenta los rayos de cada tipo en el último scan y avisa si la mayoría son inválidos.
- Con `serial` no hay LiDAR: la telemetría dice `lidar_source: "none"` y la velocidad lineal se limita a 0.15 m/s.

## Freno por eje

Si un sector está a menos de 0.28 m se anula la velocidad hacia ese lado (`vx` con frente y atrás, `vy` con izquierda y derecha) y `|wz|` se limita a 0.3 rad/s. `obstacle_alert` se enciende con cualquier sector por debajo de 0.35 m. Cuando el freno cambia un comando, la respuesta trae `blocked: "braked"`.

## Sombra del brazo

El brazo está montado sobre el frente y el LiDAR lo ve. El worker descarta los ecos que caen en la banda de `ARM_SHADOW_MIN_M` a `ARM_SHADOW_MAX_M` dentro de ±`ARM_SHADOW_HALF_ANGLE_DEG` al frente, y solo si el sector tiene otros rayos utilizables (ecos o espacio libre). Si el brazo es lo único que ve el sector, reporta el eco más cercano del brazo (bloquea). Lo que está más cerca que la banda siempre bloquea.

Los valores salen, en este orden, de las variables de entorno, del archivo de calibración `robot-bridge/arm-shadow.json` (otra ruta con `ARM_SHADOW_FILE`; está en `.gitignore` porque es de cada robot) y de los valores por defecto: 0.06 a 0.09 m dentro de ±20°. Los valores por defecto son estrechos y no están calibrados para tu robot: si el brazo cae fuera de la banda, el frente queda bloqueado (falla cerrado). **Calíbralo en el robot**:

1. Con el bridge corriendo (`make robot`) y 50 cm despejados alrededor, corre `make calibrar-sombra` en otra terminal del robot. El script ([`calibrar_sombra.py`](../robot-bridge/scripts/calibrar_sombra.py)) pide confirmar que el área está despejada, mueve **solo el brazo** por cada pose de los gestos de `gestures.rs` con `POST /arm`, lee el `/scan` crudo en cada pose y toma como brazo todo eco a menos de 30 cm dentro de ±90°.
2. Guarda la banda medida (con 1 cm y 2° de margen) en `robot-bridge/arm-shadow.json`. Si el LiDAR nunca ve el brazo, deja el filtro desactivado (`max_m = 0`). Si la banda llega a más de 0.25 m, no guarda nada: probablemente había algo dentro de los 30 cm.
3. Reinicia el bridge (Ctrl+C y `make robot`). Al arrancar, el worker escribe en la terminal la banda que usa y de dónde salió (entorno, archivo o valores por defecto).
4. Repite la sección 4 de [`ensayo.sh`](./ENSAYO.md) para confirmar que ningún gesto baja un sector de 0.28 m.

Para fijar los valores a mano, pásalos en el entorno de `make robot` (por ejemplo `ARM_SHADOW_MAX_M=0.11 make robot`); el entorno gana sobre el archivo. `ARM_SHADOW_MAX_M=0` desactiva el filtro.

## `run.sh` e `iniciar-robot.sh` en el robot

Los dos usan [`robot-bridge/scripts/robot-common.sh`](../robot-bridge/scripts/robot-common.sh):

- Abortan si existe el candado de paro de emergencia de otra app, `~/.openclaw/workspace/ESTOP_LOCK` (otra ruta con `ROSORIN_ESTOP_LOCK_FILE`). Nunca lo borran.
- Detienen `button_scan.service` y `start_app_node.service`, que ocupan `/dev/rrc`. Mientras corre el bridge, el botón físico de fábrica no actúa.
- No tocan `wifi.service`.

## Backend explícito

`--serial`, `--ros2` o `ROBOT_BACKEND` no caen a mock si fallan: el bridge sale con código `1`. Solo la autodetección de `run.sh` (e `iniciar-robot.sh`) pasa `--allow-mock-fallback`. Si el loop de control muere, el bridge detiene los motores y sale con código `70`.

## Lo que queda a la vista

- `run.sh` imprime el token en la terminal a propósito. No proyectes esa terminal en el escenario.
- La URL del kiosco que abre `iniciar-robot.sh` lleva el token en el fragmento (`/face#token=…`): no llega al servidor de Next, pero sí aparece en los argumentos del navegador (visible con `ps` en el robot).
- El bridge habla HTTP sin TLS: usa una red Wi-Fi propia del robot (WPA2), no la del evento.

## Variables

Las variables del bridge y del worker están documentadas en [`robot-bridge/.env.example`](../robot-bridge/.env.example) y las de la web en [`web/.env.example`](../web/.env.example).
