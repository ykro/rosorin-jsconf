---
name: rosorin-pro
description: Úsalo al escribir código para el manipulador móvil Hiwonder ROSOrin Pro o para el bridge en Rust de este repo — chasis Mecanum, brazo de servos de bus (IDs 1 a 5 y pinza 10), LiDAR por sectores, cámara 3D, protocolo serie del STM32 (1 Mbps, CRC8), tópicos de ROS 2 Humble, ros2_worker.py, E-stop enclavada y token del bridge.
---

# Hiwonder ROSOrin Pro: control del robot y del bridge

## Resumen

El ROSOrin Pro combina un **chasis Mecanum** con un **brazo de servos de bus** (5 articulaciones más una pinza paralela). Corre Ubuntu 22.04 y **ROS 2 Humble** en un **NVIDIA Jetson Orin Nano**, con un coprocesador **STM32** (`ros_robot_controller`) por UART.

Repositorios del fabricante:
- `https://github.com/Hiwonder/ROSOrin-Pro` (rama `orin-nano`)
- `https://github.com/Hiwonder/ROSOrin` (rama `ROS2`, versión solo chasis)

En este repo nada le habla directo al hardware salvo `robot-bridge` (Rust, binario `rosorin-bridge`, puerto 9000) y su worker `robot-bridge/scripts/ros2_worker.py`.

## Hardware

| Subsistema | Detalle | Interfaz |
|---|---|---|
| Cómputo | NVIDIA Jetson Orin Nano | Ubuntu 22.04, ROS 2 Humble |
| Coprocesador | STM32 (`ros_robot_controller`) | `/dev/rrc` (enlace a `/dev/ttyACM0`), 1 000 000 baudios, 8N1 |
| Chasis | 4 motores DC con encoder, ruedas Mecanum | `wheelbase=0.17706 m`, `track_width=0.17165 m`, `wheel_diameter=0.08 m` |
| Brazo | Servos de bus | IDs `1..5` (articulaciones) e ID `10` (pinza). Pulsos `0..1000`, `500` al centro (`0..240°`) |
| Cámara 3D | Deptrum Aurora 930 Pro / Orbbec Astra, montada en la pinza (eslabón de `joint4`) | `/depth_cam/rgb0/image_raw` (bgr8 640×400, `fx=415.853 fy=416.574 cx=322.145 cy=192.159`) y `/depth_cam/depth0/image_raw` (mono16 en mm, 640×400, válida de ~0.43 a 2.2 m) |
| LiDAR | LD19 / MS200 | `/scan` (`sensor_msgs/LaserScan`), que el worker resume en 4 sectores. Ve el frente y los lados; atrás lo tapan el chasis y los cables (`lidar.uncovered: ["back"]`) |
| Periféricos | Buzzer, LEDs RGB, pantalla táctil de 7" | Buzzer y LEDs por el STM32; la pantalla muestra la ruta web `/face` |
| Batería | 3S Li-ion | El worker la lee del STM32 en mV y descarta lecturas fuera de `8000..14000` |

## Backends del bridge

| Backend | Cómo habla con el hardware | LiDAR | Cuándo usarlo |
|---|---|---|---|
| `ros2` | Lanza `python3 ros2_worker.py`. Si puede abrir `/dev/rrc`, usa el SDK oficial (`Board("/dev/rrc", 1000000)`); si otro nodo lo tiene, publica en tópicos de ROS 2. En ambos casos se suscribe a `/scan` y a la cámara. | Sí, falla cerrado | En el robot (es lo que autodetecta `run.sh`). |
| `serial` | Escribe tramas binarias directo en `/dev/rrc` desde un hilo propio. | No: `lidar_source: "none"` y velocidad lineal máxima 0.15 m/s | Pruebas sin ROS 2. La trama de LEDs no está implementada y la batería no se lee. |
| `mock` | Nada; simula en memoria. | Simulado con `POST /simulate/lidar` (y la cámara de «Reconocer» con `POST /simulate/scene`) | Laptop y ensayos (`./run.sh --mock`). |

Un backend pedido de forma explícita (`--backend`, `ROBOT_BACKEND`, `--serial`, `--ros2`) **no cae a mock** si falla: el bridge sale con código 1. Solo con `--allow-mock-fallback` (lo pasa `run.sh` al autodetectar) prueba serial → ros2 → mock.

> **Regla:** no abras `/dev/rrc` dos veces. Si `ros_robot_controller_node` está corriendo, el worker publica en tópicos; si quieres `serial`, detén ese nodo. `run.sh` detiene `button_scan.service` y `start_app_node.service` por esa razón. `start_app_node.service` es el bringup completo de Hiwonder y también lanzaba el LiDAR y la cámara: con `ros2`, `rosorin_start_sensors` (en `robot-common.sh`) vuelve a levantar solo `ros2 launch peripherals lidar.launch.py` y `depth_camera.launch.py`, y `run.sh` los apaga al salir.

## Servos y límites (`clamp_servo_pulse` en `protocol.rs`)

Solo se aceptan los IDs `{1, 2, 3, 4, 5, 10}`. Cualquier otro ID en `/arm` o `/servo/jog` da `400 invalid_request`. Las posiciones fuera de rango no dan error: se recortan.

| Articulación | ID | Rol | Rango permitido | Nota |
|---|---|---|---|---|
| `joint1` | `1` | Base (giro) | `120..880` | `500` mira al frente |
| `joint2` | `2` | Hombro | `220..780` | Más abajo golpea la torre del LiDAR |
| `joint3` | `3` | Codo | `150..850` | |
| `joint4` | `4` | Muñeca | `150..850` | Inclina cámara y pinza |
| `joint5` | `5` | Giro de muñeca | `100..900` | |
| `r_joint` | `10` | Pinza paralela | `200..750` | `220` abierta, `680` cerrada sobre la llave |

> **La pinza es el servo 10, no el 6**, aunque los archivos de acciones `.d6a` la guarden en la columna `Servo6`.

`/arm` acepta de 1 a 6 servos, `duration_ms` se recorta a `120..5000` y `/servo/jog` exige `delta` en `-300..300`.

## Chasis y seguridad (`robot-bridge :9000`)

- **Velocidades:** `linear_x` y `linear_y` en `±0.25 m/s`, `angular_z` en `±0.8 rad/s` (con `serial`, lineales en `±0.15 m/s`).
- **Duración:** `duration_ms` se recorta a `100..2500`; por defecto vale el watchdog (`CMD_VEL_WATCHDOG_MS`, 600 ms). Al vencer, el chasis se detiene. Mientras está vigente, el bridge reenvía la velocidad cada ~100 ms.
- **Watchdog del worker:** `WATCHDOG_TIMEOUT_S = 0.50` en `ros2_worker.py`. Si pasan 500 ms sin comandos con el robot en movimiento, pone los motores en 0. Al cerrarse su stdin (el bridge murió) también.
- **Freno por eje** (`apply_lidar_brake`, umbral `LIDAR_BRAKE_M = 0.28`): `vx > 0` se anula con `front_m`, `vx < 0` con `back_m`, `vy > 0` con `left_m` y `vy < 0` con `right_m`. Si cualquier sector está por debajo de 0.28 m, `|wz|` se limita a 0.3. Se aplica al recibir el comando y en cada tick de 40 Hz. Los sectores en `lidar.uncovered` (sin ningún rayo en el scan; en el ROSOrin Pro, atrás) no frenan: la reversa manual no la detiene el LiDAR y los gestos retroceden a 0.05 m/s como máximo. Es un riesgo aceptado por el autor.
- **`obstacle_alert`:** cualquier sector cubierto por debajo de 0.35 m (los de `uncovered` no cuentan).
- **LiDAR que falla cerrado (solo `ros2`):** sin scan en más de 300 ms, o con el worker muerto, la velocidad aplicada es 0 y `lidar_stale = true`. Al arrancar el chasis queda bloqueado hasta el primer scan y los 4 sectores valen `0.0`. Un sector ciego también llega en `0.0` y bloquea.
- **Heartbeat del worker (solo `ros2`):** cada 100 ms el bridge manda `{"op":"ping","seq":N}` y el worker contesta `{"event":"pong","seq":N}` desde el hilo que ejecuta los comandos. Sin *pong* en 400 ms, o con una escritura atascada más de 300 ms, `connected = false` y el chasis queda bloqueado hasta que vuelva. Bridge y worker se actualizan juntos (`git pull` + `make build-robot`).
- **Campo `blocked`:** toda respuesta de acción (HTTP 200) trae `blocked`: `null`, `worker_dead`, `lidar_stale` o `braked`. Por WebSocket llega como `{"event":"blocked","op":…,"blocked":…,"message":…}`. Un `200` con `blocked` no nulo **no** es éxito: el robot no se movió (o se movió menos).
- **E-stop enclavada:** `POST /stop` detiene motores, congela el brazo donde está y bloquea `/cmd_vel`, `/arm`, `/servo/jog`, `/arm/jog`, `/gesture`, `/scene/reset`, `/buzzer` y `POST /scan_env` con `423 estop_latched` hasta `POST /estop/release`. El bridge también la enclava al apagarse (SIGINT o SIGTERM).
- **`POST /simulate/lidar`** y **`/simulate/scene`** solo existen en mock (`403` en hardware).

## «Reconocer» (`POST /scan_env`, `GET /scan_env`)

- Mide dónde están las bandejas (`{"scene":"gatekeeper"}`) o los tótems (`{"scene":"bughunter"}`) **moviendo solo el brazo**: pose de observación (servos 2-4 en `520, 200, 180`, `SURVEY_POSE` en `scan_env.rs`), `joint1` de `280` a `720` en 11 pausas (600 ms de movimiento y 500 ms quieto) y vuelta a `home`. Nunca manda velocidad al chasis y no toca el servo 5 ni la pinza. STOP, cualquier otro movimiento o un worker caído lo abortan; `409` si ya corre, `503` sin driver o con `serial` (sin cámara).
- En cada pausa el bridge manda al worker `{"op":"scan_env_capture","id":N,"scene":…,"servos":{"1":…,"4":…}}`. El hilo de stdin solo lo encola; el hilo `scan-env` ([`scan_env.py`](../../robot-bridge/scripts/scan_env.py), Python puro) espera un frame posterior al pedido, segmenta los colores impresos (HSV), calcula la pose de `camera_link` con la cadena del URDF y esos pulsos (no hay TF en vivo), y proyecta a `base_link`: con profundidad válida, el rayo por la profundidad; si no, el rayo cortado con el plano de la mesa (o 8 cm arriba para los tótems). Contesta `{"event":"scan_env_result","id":N,"ok":true,"detections":[…]}`.
- El bridge junta las vistas y guarda el resultado en `telemetry.scan_env` (en memoria). `gatekeeper_approve`, `gatekeeper_reject` y `point_*` apuntan `joint1` a lo medido (`500 + ángulo / 0.24°` desde el eje de `joint1`, recortado a `250..750`), sin deslizar el chasis, y lo dicen en `aim`; sin un resultado vigente (15 min, el robot no se movió más de 15 cm o 15°, confianza ≥ 0.45) usan su lado fijo.
- Bridge y worker van juntos: `make build-robot` en el robot. Los umbrales de color están en `COLOR_SPECS` y hay que validarlos con luz de escenario (`SCAN_ENV_DEBUG_DIR` guarda cada captura).

## Token y red

- El bridge escucha en `127.0.0.1` por defecto. En el robot `run.sh` lo levanta en `0.0.0.0` con `BRIDGE_TOKEN` (generado en `.bridge-token`, permisos 600). Sin token fuera de loopback, el bridge sale con código 2.
- Manda el token como `x-bridge-token: <t>` o `Authorization: Bearer <t>`. `?token=` solo vale en `/ws`. `GET /health` es público.
- `Host` debe ser una IP, `localhost` o un nombre de `BRIDGE_ALLOWED_HOSTS`; `Origin`, una IP de loopback, `localhost`, el sitio de la charla o uno de `BRIDGE_ALLOWED_ORIGINS`. Las IPs privadas solo valen como origen si hay token o el bridge escucha fuera de loopback.
- En la laptop, el token se trae con `./traer-token.sh <usuario>@<IP>` (no lo vuelve a copiar si el bridge ya acepta el que tienes; `--force` lo trae siempre) y la web lo recibe en `#token=<t>`. `./ensayo.sh --laptop --ip <IP>` hace las dos cosas y corre la guía del ensayo.
- API key de Gemini: `GEMINI_API_KEY` en el `web/.env` de donde corre el bridge. Los lanzadores se la dan al bridge por entorno; la web la pide a `GET /config/gemini-key` (con token, `Cache-Control: no-store`) y la tiene solo en memoria. Nunca va en una URL ni en `localStorage`, `sessionStorage`, cookies o IndexedDB.
- Límite global: 30 POST/s con ráfaga de 60 (`/stop` y `/estop/release` exentos).

El token se le pasa a `curl` por stdin (`-H @-`, `curl >= 7.55`) para que no aparezca en `ps`, como hace `rosorin_curl_with_token` en `robot-bridge/scripts/robot-common.sh`:

```bash
hdr() { printf 'x-bridge-token: %s\n' "$(cat .bridge-token)"; }
hdr | curl -X POST -H @- -H 'content-type: application/json' \
  -d '{"linear_x":0.1,"duration_ms":500}' http://<IP>:9000/cmd_vel
hdr | curl -X POST -H @- http://<IP>:9000/stop
hdr | curl -X POST -H @- http://<IP>:9000/estop/release
```

## Lo que hace `ros2_worker.py`

Protocolo: un JSON por línea en stdin (`{"op":"cmd_vel"|"arm"|"buzzer"|"rgb"|"ping"|"scan_env_capture",…}`) y un JSON por línea en stdout (`{"event":"backend"|"lidar"|"battery"|"camera_jpeg"|"pong"|"scan_env_result",…}`). La primera línea siempre es `{"event":"backend","name":…}`; el bridge la espera hasta 20 s. El worker arma antes el nodo de cámara y `/scan` (importar rclpy, cv2 y numpy acapara el GIL cerca de un segundo y, hecho después, atrasaría los `pong`). Cada `{"op":"ping","seq":N}` se contesta con `{"event":"pong","seq":N}` desde el hilo que lee stdin. El evento `lidar` trae además `blind` (lista de sectores ciegos; solo diagnóstico).

- **Con el SDK (`Board`):** `name = "stm32-board (/dev/rrc @ 1Mbps)"`. Mueve motores con `set_motor_speed`, servos con `bus_servo_set_position`, buzzer y LEDs con el SDK, y lee la batería cada 2 s.
- **Con tópicos (si `/dev/rrc` está ocupado):** `name = "ros2-topics"`. Publica:
  - `/controller/cmd_vel` (`geometry_msgs/msg/Twist`)
  - `/servo_controller` (`servo_controller_msgs/msg/ServosPosition`, `position_unit = "pulse"`)
  - `/ros_robot_controller/set_buzzer` (`ros_robot_controller_msgs/msg/BuzzerState`)
- **Suscripciones** (con `qos_profile_sensor_data`, que acepta publicadores *best-effort* y *reliable*):
  - `/scan`: como máximo 20 eventos `lidar` por segundo.
  - `/depth_cam/rgb0/image_raw`: JPEG en base64, como máximo 2 por segundo (requiere `cv2`). El último frame crudo se guarda para «Reconocer».
  - `/depth_cam/depth0/image_raw`: solo se guarda el último frame, para «Reconocer».
- **Sectores** (REP-103: ángulo 0 al frente, positivo a la izquierda): frente `|θ| ≤ 45°`, izquierda `45°..135°`, derecha `-135°..-45°`, atrás el resto. Cada sector reporta el eco más cercano; si solo hay espacio libre, `4.0` m.
- **Rayos** (`classify_ray`, REP 117): eco si es finito y está en `[range_min, range_max]`; libre si es `+inf` o mayor que `range_max`; inválido si es `NaN`, `-inf`, `0` o menor que `range_min` (algo pegado, ventana tapada o sucia). Un escenario con más de 12 m vacíos se ve abierto. Ojo: una superficie negra mate que no devuelve eco también se ve libre.
- **Sector ciego:** si tiene rayos pero menos de `LIDAR_MIN_VALID_FRACTION` (0.25) son utilizables (eco o libre), el sector vale `0.0` y bloquea. Un sector sin ningún rayo (recortado por el driver) no es ciego sino `uncovered`: vale `0.0` pero no frena. Así un LiDAR tapado o sucio bloquea el chasis. `LIDAR_MIN_VALID_FRACTION=0` desactiva la revisión.
- **Orientación del scan** (`load_lidar_mount`): el worker asume REP-103; un offset y un reflejo corrigen un `/scan` rotado o reflejado antes de calcular sectores y sombra (`robot_angle()` en `ros2_worker.py`, también la usa `calibrar_sombra.py`). Los valores salen de `LIDAR_ANGLE_OFFSET_DEG` y `LIDAR_FLIP` en el entorno, si no del archivo `LIDAR_MOUNT_FILE` (por defecto `robot-bridge/lidar-mount.json`, `{"offset_deg": 180, "flip": false}`, fuera de git) y si no 0° sin reflejo.
- **Sombra del brazo:** los ecos entre `ARM_SHADOW_MIN_M` y `ARM_SHADOW_MAX_M` dentro de ±`ARM_SHADOW_HALF_ANGLE_DEG` al frente se ignoran si el sector tiene otros rayos utilizables (eco o libre); si el brazo es lo único que ve el sector, se reporta (bloquea). Lo que está más cerca que `ARM_SHADOW_MIN_M` siempre bloquea. `ARM_SHADOW_MAX_M=0` desactiva el filtro.
- **Calibración de la sombra** (`load_arm_shadow`): los valores salen de las variables de entorno, si no del archivo `ARM_SHADOW_FILE` (por defecto `robot-bridge/arm-shadow.json`, fuera de git) y si no de los valores por defecto (0.06–0.09 m, ±20°), estrechos y sin calibrar. El archivo lo escribe `make calibrar-sombra` en el robot, con `make robot` corriendo: mueve solo el brazo por las 12 poses más distintas de `gestures.rs` (`select_poses`, muestreo del punto más lejano con la pinza a 0.25; `--todas` las mide todas), toma como brazo todo eco a menos de 30 cm dentro de ±90°, agrega 1 cm y 2° de margen y aborta si la banda pasa de 0.25 m. Antes revisa que `/scan` cubra al menos la mitad del frente (`cone_coverage`); si no, y girado 180° sí, ofrece escribir `lidar-mount.json`. Después hay que reiniciar el bridge; el worker dice en stderr de dónde salió la banda.

Tests sin rclpy: `python3 -m unittest discover -s robot-bridge/scripts -p 'test_*.py'`.

## Protocolo serie del STM32 (`/dev/rrc` a 1 000 000 baudios)

Con `--backend serial`, cada trama es:

```text
[0xAA, 0x55, func_id: u8, data_len: u8, ...data_bytes, crc8: u8]
```

- `crc8` se calcula sobre `[func_id, data_len, ...data_bytes]` con la tabla Dallas/Maxim (`CRC8_TABLE` en `protocol.rs`, igual a `crc8_table` de `ros_robot_controller_sdk.py`).
- Funciones (`PacketFunction`):
  - `0x00` `SYS` (reporte de batería: subcomando `0x04` + `u16` little-endian en mV)
  - `0x01` `LED`
  - `0x02` `BUZZER` (`<HHHH`: `freq_hz, on_ms, off_ms, repeat`)
  - `0x03` `MOTOR` (`[0x01, count, …(motor_idx_base_0: u8, rps: f32_le)]`)
  - `0x05` `BUS_SERVO` (`[0x01, dur_lo, dur_hi, count, …(servo_id: u8, pulse: u16_le)]`)
  - `0x07` `IMU`

### Cinemática Mecanum (m/s a vueltas por segundo)

Así está en `mecanum_ik` de `protocol.rs`:

```rust
pub fn mecanum_ik(linear_x: f32, linear_y: f32, angular_z: f32) -> [f32; 4] {
    let (vx, vy, wz) = clamp_velocity(linear_x, linear_y, angular_z);
    let k = (WHEELBASE_M + TRACK_WIDTH_M) / 2.0;
    let m1 = vx - vy - wz * k;
    let m2 = vx + vy - wz * k;
    let m3 = vx + vy + wz * k;
    let m4 = vx - vy + wz * k;
    let circumference = PI * WHEEL_DIAMETER_M;
    [
        m1 / circumference,
        m2 / circumference,
        -m3 / circumference,
        -m4 / circumference,
    ]
}
```

Los motores 3 y 4 (lado derecho) están montados invertidos.

## Referencia del stack de Hiwonder (no lo usa el bridge)

Útil si trabajas directo con los nodos del fabricante: `odom_publisher_node` recorta `/cmd_vel` a `±0.2 m/s` y `±0.5 rad/s`, y `/controller/cmd_vel` entra sin recorte a la cinemática. El bridge aplica sus propios límites antes de llegar a cualquiera de los dos.

## Errores comunes

| Error | Solución |
|---|---|
| Mandar la pinza al servo 6 | La pinza es el **servo 10**. Otro ID da `400`. |
| Usar `wheel_diameter=0.0065` de `mecanum.py` | Es un error en el valor por defecto de Hiwonder; el real es `0.08` (80 mm). |
| Mover el chasis sin plazo | Siempre manda `duration_ms` o deja que el watchdog (600 ms) corte. |
| Bajar `joint2` de 220 | Choca con la torre del LiDAR; el bridge lo recorta. |
| Abrir `/dev/rrc` con `ros_robot_controller_node` activo | Usa `ros2` (el worker publica en tópicos) o detén ese nodo para `serial`. |
| Reintentar un movimiento que dio `423` | La E-stop está enclavada a propósito. Avisa y espera `POST /estop/release`. |
| Llamar al bridge sin token desde la LAN | Manda `x-bridge-token`; `401` significa token faltante o distinto. |
| Asumir que el avance está libre porque el frente lo está | El freno es por eje: un `vy` hacia una pared lateral también se anula, y girar se limita a 0.3 rad/s cerca de obstáculos. |
| Usar `ros2` sin `/scan` publicándose | El chasis queda bloqueado (`lidar_stale`). Revisa `ros2 topic hz /scan`. |
| Actualizar el bridge sin el worker (o al revés) | Un worker sin *pong* deja `connected = false` y el chasis bloqueado. En el robot: `git pull` y `make build-robot`. |
| Tratar un `200` como «se movió» | Revisa `blocked`; si no es `null`, el robot no se movió como pediste. |
| El frente bloqueado por el brazo en algunos gestos | Calibra la sombra con `make calibrar-sombra` en el robot y reinicia `make robot`. |
