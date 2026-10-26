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
| Cámara 3D | Deptrum Aurora 930 Pro / Orbbec Astra | `/depth_cam/rgb0/image_raw` |
| LiDAR | LD19 / MS200 | `/scan` (`sensor_msgs/LaserScan`), que el worker resume en 4 sectores |
| Periféricos | Buzzer, LEDs RGB, pantalla táctil de 7" | Buzzer y LEDs por el STM32; la pantalla muestra la ruta web `/face` |
| Batería | 3S Li-ion | El worker la lee del STM32 en mV y descarta lecturas fuera de `8000..14000` |

## Backends del bridge

| Backend | Cómo habla con el hardware | LiDAR | Cuándo usarlo |
|---|---|---|---|
| `ros2` | Lanza `python3 ros2_worker.py`. Si puede abrir `/dev/rrc`, usa el SDK oficial (`Board("/dev/rrc", 1000000)`); si otro nodo lo tiene, publica en tópicos de ROS 2. En ambos casos se suscribe a `/scan` y a la cámara. | Sí, falla cerrado | En el robot (es lo que autodetecta `run.sh`). |
| `serial` | Escribe tramas binarias directo en `/dev/rrc` desde un hilo propio. | No: `lidar_source: "none"` y velocidad lineal máxima 0.15 m/s | Pruebas sin ROS 2. La trama de LEDs no está implementada y la batería no se lee. |
| `mock` | Nada; simula en memoria. | Simulado con `POST /simulate/lidar` | Laptop y ensayos (`./run.sh --mock`). |

Un backend pedido de forma explícita (`--backend`, `ROBOT_BACKEND`, `--serial`, `--ros2`) **no cae a mock** si falla: el bridge sale con código 1. Solo con `--allow-mock-fallback` (lo pasa `run.sh` al autodetectar) prueba serial → ros2 → mock.

> **Regla:** no abras `/dev/rrc` dos veces. Si `ros_robot_controller_node` está corriendo, el worker publica en tópicos; si quieres `serial`, detén ese nodo. `run.sh` detiene `button_scan.service` y `start_app_node.service` por esa razón.

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
- **Freno por eje** (`apply_lidar_brake`, umbral `LIDAR_BRAKE_M = 0.28`): `vx > 0` se anula con `front_m`, `vx < 0` con `back_m`, `vy > 0` con `left_m` y `vy < 0` con `right_m`. Si cualquier sector está por debajo de 0.28 m, `|wz|` se limita a 0.3. Se aplica al recibir el comando y en cada tick de 40 Hz.
- **`obstacle_alert`:** cualquier sector por debajo de 0.35 m.
- **LiDAR que falla cerrado (solo `ros2`):** sin scan en más de 300 ms, o con el worker muerto, la velocidad aplicada es 0 y `lidar_stale = true`. Al arrancar el chasis queda bloqueado hasta el primer scan.
- **E-stop enclavada:** `POST /stop` detiene motores, congela el brazo donde está y bloquea `/cmd_vel`, `/arm`, `/servo/jog`, `/arm/jog`, `/gesture`, `/scene/reset` y `/buzzer` con `423 estop_latched` hasta `POST /estop/release`.
- **`POST /simulate/lidar`** solo existe en mock (`403` en hardware).

## Token y red

- El bridge escucha en `127.0.0.1` por defecto. En el robot `run.sh` lo levanta en `0.0.0.0` con `BRIDGE_TOKEN` (generado en `.bridge-token`, permisos 600). Sin token fuera de loopback, el bridge sale con código 2.
- Manda el token como `x-bridge-token: <t>` o `Authorization: Bearer <t>`. `?token=` solo vale en `/ws`. `GET /health` es público.
- `Host` debe ser una IP, `localhost` o un nombre de `BRIDGE_ALLOWED_HOSTS`; `Origin`, una IP privada o de loopback, `localhost`, el sitio de la charla o uno de `BRIDGE_ALLOWED_ORIGINS`.
- Límite global: 30 POST/s con ráfaga de 60 (`/stop` y `/estop/release` exentos).

```bash
TOKEN=$(cat .bridge-token)
curl -X POST -H "x-bridge-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"linear_x":0.1,"duration_ms":500}' http://<IP>:9000/cmd_vel
curl -X POST -H "x-bridge-token: $TOKEN" http://<IP>:9000/stop
curl -X POST -H "x-bridge-token: $TOKEN" http://<IP>:9000/estop/release
```

## Lo que hace `ros2_worker.py`

Protocolo: un JSON por línea en stdin (`{"op":"cmd_vel"|"arm"|"buzzer"|"rgb",…}`) y un JSON por línea en stdout (`{"event":"backend"|"lidar"|"battery"|"camera_jpeg",…}`). La primera línea siempre es `{"event":"backend","name":…}`; el bridge la espera hasta 20 s.

- **Con el SDK (`Board`):** `name = "stm32-board (/dev/rrc @ 1Mbps)"`. Mueve motores con `set_motor_speed`, servos con `bus_servo_set_position`, buzzer y LEDs con el SDK, y lee la batería cada 2 s.
- **Con tópicos (si `/dev/rrc` está ocupado):** `name = "ros2-topics"`. Publica:
  - `/controller/cmd_vel` (`geometry_msgs/msg/Twist`)
  - `/servo_controller` (`servo_controller_msgs/msg/ServosPosition`, `position_unit = "pulse"`)
  - `/ros_robot_controller/set_buzzer` (`ros_robot_controller_msgs/msg/BuzzerState`)
- **Suscripciones** (con `qos_profile_sensor_data`, que acepta publicadores *best-effort* y *reliable*):
  - `/scan`: como máximo 20 eventos `lidar` por segundo.
  - `/depth_cam/rgb0/image_raw`: JPEG en base64, como máximo 2 por segundo (requiere `cv2`).
- **Sectores** (REP-103: ángulo 0 al frente, positivo a la izquierda): frente `|θ| ≤ 45°`, izquierda `45°..135°`, derecha `-135°..-45°`, atrás el resto. Cada sector reporta el eco válido más cercano; sin ecos, `4.0` m.
- **Sombra del brazo:** los ecos más cercanos que `ARM_SHADOW_MAX_M` (0.12 m) dentro de ±`ARM_SHADOW_HALF_ANGLE_DEG` (35°) se consideran el propio brazo y se ignoran si el sector tiene otros ecos. Si solo quedan ecos filtrados, se reporta el más cercano (falla cerrado). `ARM_SHADOW_MAX_M=0` desactiva el filtro. **Calíbralo en el robot** con `ros2 topic echo /scan`.

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
