# Rust para Web Developers: Cómo funciona `robot-bridge`

![Modelo Mental: De TypeScript y Node.js a Rust en el Robot](./assets/rust-mental-model.svg)

Si vienes del mundo de **TypeScript, Node.js y Next.js**, el código de [`robot-bridge/`](../robot-bridge/src/main.rs) es sorprendentemente familiar. No necesitas ser experto en sistemas embebidos para entenderlo: cumple exactamente el rol de un servidor **Express + `ws`** ligero en el puerto **`:9000`** (`BRIDGE_PORT`), pero compilado a código nativo con garantías en tiempo de ejecución para proteger los motores físicos del robot.

---

## 1. El Modelo Mental: De Node.js a Rust

| Concepto en Web (Node.js / TS) | Equivalente en `robot-bridge` (Rust) | ¿Por qué importa en robótica física? |
| :--- | :--- | :--- |
| **Node.js Event Loop** (`async/await`) | **`tokio` runtime** (`#[tokio::main]`) | Ejecuta tareas I/O concurrentes y timers exactos de `25 ms` (`40 Hz`) y `50 ms` (`20 Hz`) sin deriva temporal. |
| **Express / Fastify + `ws`** | **`axum`** (`Router`, `WebSocketUpgrade`) | Levanta los endpoints HTTP REST y `/ws` en el puerto `:9000` con latencia sub-milisegundo. |
| **Estado global en memoria** (`let state = {...}`) | **`Arc<Mutex<TelemetryState>>`** (en `BridgeService` / `AppState`) | El compilador garantiza en tiempo de compilación que ningún hilo corrompa la telemetría mientras otro la actualiza. |
| **Zod + `JSON.parse()`** | **`serde` + `serde_json`** (`#[derive(Deserialize)]`) | Deserializa y valida tipos estrictamente antes de tocar un solo registro del hardware. |
| **Driver Serial en JS (`serialport`)** | **Crate `serialport` (`1,000,000 bps`)** | Escribe tramas binarias `0xAA 0x55` con `CRC8` directamente en `/dev/rrc` (STM32) sin sobrecarga. |
| **Garbage Collector (V8)** | **Ownership & Lifetimes (RAII)** | **0 ms de pausas de GC**. En un lazo de control a `40 Hz`, una pausa de 30 ms detendría un servo a mitad de trayectoria. |

---

## 2. Los 3 Loops Concurrentes en Memoria Compartida

![Los 3 Loops Concurrentes en Tokio y Memoria Compartida](./assets/rust-control-loops.svg)

Cuando arrancas `cargo run -- --backend mock` (o `./run.sh --mock` en tu laptop, o el binario en el Jetson Orin Nano), `robot-bridge` inicializa `BridgeService` dentro de `AppState` con una única instancia de **`Arc<Mutex<TelemetryState>>`** y coordina tres tareas asíncronas (`tokio::spawn`) en paralelo:

1. **WebSocket Broadcast (`20 Hz` / cada `50 ms`)**: Cada 2 ticks del reloj de `40 Hz`, clona una instantánea de `TelemetryState` (`servos`, `target_servos`, `odometry`, batería y los **4 sectores del LiDAR** `front_m`, `left_m`, `right_m`, `back_m` + `obstacle_alert`) y la publica por un canal `tokio::sync::broadcast` a todos los clientes WebSocket conectados en `/ws`.
2. **Receptor de Comandos HTTP REST y WebSocket (`WsClientCommand`)**: Escucha peticiones REST y mensajes WebSocket etiquetados con `"op"` (`cmd_vel`, `gesture`, `arm`, `jog`, `reset_scene`, `stop`), adquiere el `Mutex` durante microsegundos y actualiza las metas del robot.
3. **Kinematics & Safety Loop (`40 Hz` / cada `25 ms`)**: Ejecuta `service.tick(0.025)` para integrar la odometría cinemática $(x, y, \theta)$ de las 4 llantas Mecanum, interpolar suavemente los pulsos de los 6 servos hacia su `target_servos` (`900 pulsos/s`) y aplicar las **4 barreras de seguridad física**.

---

## 3. Las 4 Barreras de Seguridad (Por qué Rust protege al hardware)

![Pipeline de 4 Barreras de Seguridad de Hardware en Rust](./assets/rust-safety-pipeline.svg)

Cuando conectas un LLM multimodal como **Gemini 3.8 Live** a un robot real, nunca debes permitir que la salida de una red neuronal controle directamente el bus serial de los motores. `robot-bridge` actúa como un **firewall determinista de hardware** en cuatro etapas:

1. **Tipado Estricto y Validación de IDs (`serde` + `is_valid_servo_id`)**: Solo se aceptan los IDs físicos reales **`{1, 2, 3, 4, 5, 10}`**; cualquier otro ID (como el clásico error de enviar `ID 6` a la pinza) o JSON fuera de rango devuelve `400 Bad Request` antes de tocar `TelemetryState`.
2. **Clamping de Rango Físico por Articulación (`clamp_servo_pulse`)**: Cada servo tiene su propio rango mecánico seguro en la escala `0..1000`:
   - `J1 (ID 1)`: **`120..880`** (base yaw)
   - `J2 (ID 2)`: **`220..780`** (hombro — protege contra colisión con la torre LiDAR MS200)
   - `J3 (ID 3)`: **`150..850`** (codo)
   - `J4 (ID 4)`: **`150..850`** (muñeca pitch)
   - `J5 (ID 5)`: **`100..900`** (muñeca roll)
   - `Pinza (ID 10)`: **`200..750`** (`220` abierta, `680` cerrada sujetando la llave)
3. **Reflejo Autónomo de LiDAR (`< 0.28 m` a `40 Hz`)**: Tanto al recibir `set_velocity` como en cada iteración de `tick()` a `40 Hz`, si `lidar.front_m < 0.28 m` (alimentado por `/scan` en `ros2_worker.py`, o por `/simulate/lidar` exclusivamente en modo `mock`) mientras el robot intenta avanzar (`linear_x > 0`), Rust anula inmediatamente `vx = 0.0` y envía velocidad cero a los motores sin esperar respuesta de la nube ni del navegador.
4. **Deadman Watchdog (`600 ms`) y Límites de Chasis**: Las velocidades se recortan a **`±0.25 m/s`** (`linear_x`, `linear_y`) y **`±0.80 rad/s`** (`angular_z`), con `duration_ms` entre **`100..2500 ms`** (`600 ms` por defecto). Si el Wi-Fi del escenario falla o expira la ventana del comando, el bucle de `40 Hz` detiene los 4 motores Mecanum automáticamente.
