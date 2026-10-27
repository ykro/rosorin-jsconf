# Guía de onboarding y modos de ejecución

![Modos de ejecución: simulador en la laptop y laptop conectada al robot](./assets/onboarding-modes.svg)

El mismo código TypeScript y el mismo binario de Rust (`rosorin-bridge`, en la carpeta `robot-bridge/`) sirven para dos modos:

1. **Simulador en tu laptop (`--mock`).** El bridge simula el chasis Mecanum, los 6 servos y el LiDAR en memoria. No necesitas robot.
2. **Laptop conectada al robot por Wi-Fi (`--robot-ip <IP>`).** La web, el gemelo 3D y el micrófono corren en tu laptop (`http://localhost:3000`) y los comandos viajan por Wi-Fi al bridge del robot (`http://<IP_DEL_ROBOT>:9000`), protegido con token.

Para el ensayo con el robot físico antes de la charla sigue [`ENSAYO.md`](./ENSAYO.md).

---

## 1. Requisitos

- **Node.js 22** ([`.nvmrc`](../.nvmrc); `web/package.json` exige `>= 22.6`) y `npm`.
- **Rust con `cargo >= 1.87`**. En Linux o WSL instala antes `libudev-dev` y `pkg-config` (`sudo apt-get install -y libudev-dev pkg-config`), que pide el crate `serialport`. Si falta, `./run.sh` pregunta antes de instalarlo con rustup; en una terminal no interactiva aborta salvo con `--yes` o `ASSUME_YES=1`. Lo mismo hace con Node (vía fnm).
- **API key de Gemini** de [Google AI Studio](https://aistudio.google.com/apikey). Lo más cómodo: copia [`web/.env.example`](../web/.env.example) a `web/.env` y llena `GEMINI_API_KEY` (no es `NEXT_PUBLIC_`, así que no entra al bundle). `run.sh` la pasa en el fragmento de la URL que imprime (`#token=…&gemini_key=…`) y la web ya no la pide. Si no la defines, pégala en el navegador (botón «Ingresar API Key» de la consola de cada demo, o panel «Gemini Live API Key» en `/demo`). En los dos casos se guarda en `localStorage` como `rosorin_gemini_api_key`.
- **En el robot:** Ubuntu 22.04 con ROS 2 Humble y el SDK de Hiwonder (lo usa `robot-bridge/scripts/ros2_worker.py`).

---

## 2. Modo 1: todo en tu laptop

```bash
git clone https://github.com/ykro/rosorin-jsconf.git
cd rosorin-jsconf
./run.sh --mock
```

Levanta dos procesos:

- **Bridge en Rust** (`cargo run --release -- --backend mock --host 127.0.0.1 --port 9000`): `http://localhost:9000`, con telemetría por WebSocket a 20 Hz en `ws://localhost:9000/ws`. Solo escucha en loopback y, en este modo, no pide token.
- **Web Next.js 15** en `http://localhost:3000`, también solo en `127.0.0.1`.

`run.sh` imprime la URL que debes abrir. En mock es `http://localhost:3000/`. Ábrela con `localhost` y no con la IP de tu laptop: un bridge en loopback sin token rechaza los orígenes con IP privada (`403 forbidden_origin`).

Prueba el bridge desde la terminal:

```bash
curl http://localhost:9000/health      # {"status":"ok"}
curl http://localhost:9000/status      # telemetría completa
```

### Rutas de la web

La lista de rutas (`/demo`, `/robot`, `/face`, las 4 demos…) y cómo funcionan los gestos del simulador están en [`WEB.md`](./WEB.md).

---

## 3. Modo 2: tu laptop conectada al robot

### Paso 1: actualizar el repo en el robot

Conéctate por SSH al Jetson Orin Nano del ROSOrin Pro y actualiza el repo y el binario:

```bash
cd <ruta-del-repo>
git pull
make build-robot
```

- Si `git pull` falla, el clon es anterior a la reescritura del historial (se sacaron los MP3). Actualízalo con `git fetch origin && git reset --hard origin/main`, que descarta los cambios locales sin commit.
- **El bridge y el worker se actualizan juntos.** `make build-robot` recompila el binario de release, que es el que usa `iniciar-robot.sh`. Un bridge nuevo con un `ros2_worker.py` viejo marca `connected=false` y bloquea el chasis, porque el worker viejo no contesta el *heartbeat* (ver [`SECURITY.md`](./SECURITY.md#worker-que-no-responde)).

### Paso 2: levantar el bridge en el robot

```bash
make robot            # equivale a ./run.sh --bridge-only
```

En el robot, `run.sh`:

- Carga ROS 2 Humble (`/opt/ros/humble`, `~/ros2_ws`, `~/mission_ws`) y elige el backend `ros2` (o `serial` si no hay ROS 2 pero existe `/dev/rrc` o `/dev/ttyACM0`). Como el backend se autodetectó, pasa `--allow-mock-fallback`: si el hardware no arranca, cae a mock y lo avisa.
- Toma el token de `BRIDGE_TOKEN` o de `.bridge-token`; si no existe, genera uno con `openssl rand -hex 16` y lo guarda en `.bridge-token` con permisos `600`.
- Detiene con `sudo` `button_scan.service` y `start_app_node.service`, que ocupan `/dev/rrc`. Mientras corre el bridge, el botón físico de fábrica no actúa: usa el **STOP** de la web.
- `start_app_node.service` es el bringup completo de Hiwonder y también lanzaba el LiDAR y la cámara, así que con el backend `ros2` vuelve a levantar solo `peripherals lidar.launch.py` y `depth_camera.launch.py` (si ya corren, no los duplica) y los apaga al salir. Ver [`SECURITY.md`](./SECURITY.md#runsh-e-iniciar-robotsh-en-el-robot).
- No toca `wifi.service`. Si existe `~/.openclaw/workspace/ESTOP_LOCK` (el candado de E-stop de otra app; otra ruta con `ROSORIN_ESTOP_LOCK_FILE`), aborta sin borrarlo.
- Levanta `rosorin-bridge` en `0.0.0.0:9000` con `cargo run --release` y el token por variable de entorno (no aparece en `ps`).

Estas salvaguardas viven en [`robot-bridge/scripts/robot-common.sh`](../robot-bridge/scripts/robot-common.sh), que comparten `run.sh` e `iniciar-robot.sh`.

Si corres `./run.sh` en el robot sin `--bridge-only`, también levanta la web en el propio robot (`127.0.0.1:3000`, modo ligero). Para la pantalla de 7" está `./iniciar-robot.sh`: aborta si existe el candado de E-stop, arranca bridge (con `target/release/rosorin-bridge` si existe) y web si hace falta, y abre `/face#token=<token>` en modo kiosco.

### Paso 3: traer el token a tu laptop

En tu laptop, desde la raíz del repo:

```bash
./traer-token.sh <usuario>@<IP_DEL_ROBOT>
```

- Lee `.bridge-token` del robot por SSH (el token viaja por la salida de `ssh`, nunca en argumentos) y lo guarda en tu `.bridge-token` con permisos `600`.
- Si ya tienes `.bridge-token` y el bridge del robot lo acepta, no lo vuelve a copiar. Si el bridge no responde, lo trae y solo reemplaza el tuyo si cambió. `--force` lo trae siempre (`./traer-token.sh --force <usuario>@<IP>`).
- Sin `<usuario>@` usa `ROBOT_USER` o tu usuario local.
- Busca el repo en `~/Desktop/rosorin-jsconf` del robot. Si está en otra ruta, pásala como segundo argumento (`./traer-token.sh <usuario>@<IP> <ruta-del-repo>`) o en `ROBOT_REPO`.
- Si falla, revisa la IP, el usuario y que `make robot` ya haya corrido en el robot (es lo que genera el token).

Alternativas: copiarlo con `scp <usuario>@<IP_DEL_ROBOT>:<ruta-del-repo>/.bridge-token .bridge-token && chmod 600 .bridge-token`, o exportarlo a mano: `BRIDGE_TOKEN=<token> ./run.sh --robot-ip <IP_DEL_ROBOT>`.

Comprueba que el bridge responde (el token va por stdin para que no quede en el historial ni en `ps`; requiere `curl >= 7.55`):

```bash
curl http://<IP_DEL_ROBOT>:9000/health          # público
printf 'x-bridge-token: %s\n' "$(cat .bridge-token)" | curl -H @- http://<IP_DEL_ROBOT>:9000/status
```

### Paso 4: levantar la web en tu laptop

```bash
./run.sh --robot-ip <IP_DEL_ROBOT>
```

Sin token, el script se detiene y te sugiere `./traer-token.sh`. Con token, imprime una URL como:

```text
http://localhost:3000/?bridge=http://<IP_DEL_ROBOT>:9000#token=<token>
```

Ábrela. El token va en el fragmento (`#token=`, y `&gemini_key=` si definiste `GEMINI_API_KEY`), que el navegador no manda al servidor de Next. La web guarda el token en `localStorage` (`ROSORIN_BRIDGE_TOKEN`) y la URL del bridge (`ROSORIN_BRIDGE_URL`), y quita el token de la barra de direcciones. Desde ahí lo manda como `x-bridge-token` en cada petición y como `?token=` al abrir `/ws`.

Al cerrar `run.sh` con Ctrl+C, el script manda `POST /stop` al bridge, también al del robot: la E-stop queda enclavada hasta que la liberes.

Otras formas de pasar el token o el bridge:

- Pulsa la píldora del robot en la barra superior: abre un panel con el host del bridge, su URL, el token, «Conectar al robot» y **STOP**.
- `?bridge=http://<IP>:9000` en cualquier ruta cambia el bridge (solo acepta `localhost` o IPs de la red local). Si el host cambia, la web borra el token guardado, salvo que la misma URL traiga uno nuevo.
- `?token=<token>` también funciona, pero `#token=` es preferible. `?bridge=reset` y `#token=reset` borran lo guardado.

Nunca pongas el token en una variable `NEXT_PUBLIC_*`: se incrusta en el bundle.

### Paso 5: ensayar con el robot

Antes de subir al escenario, corre `./ensayo.sh --robot` en el robot (actualiza, compila, imprime la IP y levanta el bridge) y `./ensayo.sh --laptop --ip <IP_DEL_ROBOT>` en la laptop (trae el token, levanta la web y corre la guía). Los pasos 1 a 4 quedan hechos por el script. La guía revisa versión, token, worker, LiDAR, sombra del brazo, ruedas, STOP y demos, y deja una bitácora con los valores medidos. Todo el flujo está en [`ENSAYO.md`](./ENSAYO.md).

> [!IMPORTANT]
> **¿Por qué `http://localhost:3000` y no la IP del robot en el navegador?** El micrófono (`getUserMedia`) solo funciona en contextos seguros: `https://` o `http://localhost`. Además, el sitio público (`https://jsconfmx26.web.app`) no sirve para el robot físico: su CSP solo permite `localhost:9000` y `127.0.0.1:9000`, y una página `https://` no puede llamar a una IP `http://` de la red local.

---

## 4. STOP / E-stop

- **Activar:**
  - Botón **STOP** fijo en la barra superior o tecla **Escape** (no actúa mientras escribes en un campo; si el panel del robot está abierto, primero lo cierra). Funciona aunque el WebSocket esté caído.
  - Botón **STOP** en `/face` (aparece siempre que el bridge está habilitado).
  - Botón **STOP** del panel del robot.
  - `make reset` en la máquina del bridge, o `printf 'x-bridge-token: %s\n' "$(cat .bridge-token)" | curl -H @- -X POST http://<IP>:9000/stop`.
- **Efecto:** motores a 0, brazo congelado donde está (no vuelve a `home`) y E-stop enclavada. Toda ruta de movimiento responde `423 estop_latched` y la web muestra el banner «STOP activo».
- **Liberar:** botón «Liberar» del banner, `make release` o el mismo `curl` contra `/estop/release`.

`make reset` y `make release` leen el token de `BRIDGE_TOKEN` o de `.bridge-token` y se lo pasan a `curl` por stdin.

---

## 5. Banderas de `./run.sh`

`./run.sh --help` muestra la misma lista. Una bandera desconocida es un error.

| Bandera | Ejemplo | Qué hace |
|---|---|---|
| `--mock` | `./run.sh --mock` | Fuerza el backend mock. Bridge en `127.0.0.1`. |
| `--serial` | `./run.sh --serial` | Fuerza el backend serial directo al STM32 (`/dev/rrc`, 1 Mbps). No tiene LiDAR: velocidad lineal máxima 0.15 m/s. Si falla, el bridge sale con error. |
| `--ros2` | `./run.sh --ros2` | Fuerza el backend ROS 2 (`ros2_worker.py`). Si falla, el bridge sale con error. |
| `--bridge-only` | `./run.sh --bridge-only` | Solo el bridge, sin la web. Escucha en `0.0.0.0` con token. |
| `--robot-ip <IP>` / `--ip <IP>` | `./run.sh --robot-ip 10.0.0.42` | Solo la web en tu laptop, contra el bridge de `<IP>:9000`. Exige token. |
| `--port <W:B>` / `-p` | `./run.sh --port 3001:9001` | Puertos de web y bridge. Con un solo número decide por el valor (menor a 6000 es la web). |
| `--web-port <P>` | `./run.sh --web-port 3001` | Puerto de la web (3000 por defecto). |
| `--bridge-port <P>` | `./run.sh --bridge-port 9001` | Puerto del bridge (9000 por defecto). |
| `--web-lan` | `./run.sh --mock --web-lan` | Expone la web en `0.0.0.0`. Por defecto solo `127.0.0.1`. |
| `--yes` / `-y` | `./run.sh --yes` | Instala Rust o Node sin preguntar si faltan. |
| `--help` / `-h` | `./run.sh --help` | Muestra la ayuda. |

Variables de entorno que lee `run.sh`: `BRIDGE_TOKEN`, `ROBOT_BACKEND` (explícito, sin caída a mock), `ROBOT_IP`, `WEB_PORT`, `BRIDGE_PORT`, `ASSUME_YES`, `WEB_LAN` y, a través de `robot-common.sh`, `ROSORIN_ESTOP_LOCK_FILE`. Las del bridge están en [`robot-bridge/.env.example`](../robot-bridge/.env.example) y las de la web en [`web/.env.example`](../web/.env.example).

---

## 6. Problemas comunes

| Síntoma | Causa y solución |
|---|---|
| El bridge sale con código `2` | Escucha fuera de loopback sin `BRIDGE_TOKEN`. Define el token o usa `--host 127.0.0.1`. |
| El bridge sale con código `1` | El backend pedido (`--serial`, `--ros2` o `ROBOT_BACKEND`) no arrancó, o el nombre no existe. |
| Banner «El bridge pide token» | Falta el token o no coincide. Tráelo con `./traer-token.sh`, pégalo en el panel del robot o abre la web con `#token=<token>`. Si cambiaste de host del bridge, la web borró el token a propósito. |
| `403 forbidden_origin` o `forbidden_host` | La página o el nombre del robot no están permitidos. Agrega el origen a `BRIDGE_ALLOWED_ORIGINS` o el nombre (por ejemplo `rosorin.local`) a `BRIDGE_ALLOWED_HOSTS`. En mock, abre `http://localhost:3000` y no la IP de la laptop. |
| Banner «LiDAR sin datos: chasis bloqueado» | Con `ros2` no llega `/scan` desde hace más de 300 ms (o el worker murió). El brazo sigue funcionando; revisa el driver del LiDAR con `ros2 topic hz /scan`. |
| `connected=false` en `/status` y las herramientas responden `worker_dead` | El worker no contesta el *heartbeat*. Lo más común: bridge y worker de versiones distintas. En el robot, `git pull`, `make build-robot` y reinicia `make robot`. |
| El robot retrocede sin frenar ante algo detrás | Es lo esperado: el LiDAR del ROSOrin Pro solo cubre el frente y los lados (`lidar.uncovered: ["back"]`). La reversa manual no frena y los gestos retroceden lento. Mira detrás antes de retroceder y nunca lo hagas en una mesa. |
| El robot no avanza aunque no hay nada enfrente | El frente está bloqueado por la sombra del brazo o por un sector ciego. Mira `lidar.front_m` en `/status`: si vale `0.0`, el sector está ciego (LiDAR tapado o sucio, o un driver que reporta el vacío como `0`/`NaN`; ver [`SECURITY.md`](./SECURITY.md#lidar-que-falla-cerrado)); si es menor a 0.28 m, el brazo cae fuera de la banda de sombra: en el robot, con `make robot` corriendo, corre `make calibrar-sombra` y reinicia `make robot` ([`SECURITY.md`](./SECURITY.md#sombra-del-brazo)). Si el frente está ciego aunque el LiDAR esté limpio, revisa la orientación: un LiDAR girado 180° necesita `robot-bridge/lidar-mount.json` (sección 3 de [`ENSAYO.md`](./ENSAYO.md)). |
| Todo responde `423` | La E-stop está enclavada (también pasa al cerrar `run.sh` en la laptop, que manda `/stop`). Libérala con «Liberar» o `make release`. |
| `429 rate_limited` | Más de 30 POST por segundo (ráfaga de 60). `/stop` siempre pasa. |
| `git pull` falla en el robot | El historial se reescribió: `git fetch origin && git reset --hard origin/main`. |
| La página muestra «Sin WebGL: el simulador 3D no está disponible» | El navegador no tiene WebGL. El resto de la página sigue funcionando, incluido el STOP; prueba otro navegador o activa la aceleración por hardware. |
