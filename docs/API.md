# Especificación de API y Contrato Formal

![Flujo del Contrato de API: Gemini 3.8 Live, Cliente Web y Rust Bridge](./assets/api-flow.svg)

El sistema expone dos interfaces programáticas acopladas:
1. **API HTTP REST + WebSocket (`http://<HOST>:9000`)**: Servida por el binario en Rust `rosorin-bridge` (`axum` + `tokio`) para controlar el chasis omnidireccional Mecanum, el brazo robótico de 6 grados de libertad (`IDs 1..5` + pinza `ID 10`), los periféricos (`RGB`, `buzzer`) y la pantalla táctil integrada (`/face` / `/hud`).
2. **Gemini 3.8 Live Function Declarations (`EMBODIED_TOOLS` y `BUMBLEBEE_TOOLS`)**: Herramientas invocadas en tiempo real sobre el WebSocket multimodal de `gemini-3.8-live`.

> [!NOTE]
> La especificación formal en formato **OpenAPI 3.1.0** está disponible en [`docs/openapi.yaml`](./openapi.yaml) para importarla en Postman, Bruno, Insomnia o generadores de clientes tipados.

---

## Parte I · Guía Explicativa de Endpoints (`rosorin-bridge :9000`)

### 1. `GET /status`
Devuelve una instantánea (`TelemetryState`) del estado físico o simulado del robot.

```json
{
  "backend": "stm32-board (/dev/rrc @ 1Mbps)",
  "connected": true,
  "battery_mv": 11850,
  "servos": { "1": 500, "2": 430, "3": 310, "4": 380, "5": 500, "10": 680 },
  "target_servos": { "1": 500, "2": 430, "3": 310, "4": 380, "5": 500, "10": 680 },
  "rgb": [15, 118, 110],
  "active_gesture": "gatekeeper_hold",
  "mood": "guarding",
  "held_object": "deploy_key",
  "pointed_totem": null,
  "speaking": false,
  "listening": true,
  "hud_headline": "CUSTODIANDO LLAVE",
  "hud_subtext": "Servo ID 10 · Pulso Cerrado 680",
  "odometry": { "x_m": 0.0, "y_m": 0.0, "yaw_rad": 0.0, "vx": 0.0, "vy": 0.0, "wz": 0.0 },
  "lidar": { "front_m": 1.42, "left_m": 1.85, "right_m": 1.76, "back_m": 2.1, "obstacle_alert": false },
  "last_command_ms_ago": 120,
  "timestamp_ms": 1729539600000
}
```

### 2. `POST /gesture`
Ejecuta una coreografía física multi-etapa definida en [`robot-bridge/src/gestures.rs`](../robot-bridge/src/gestures.rs) (trayectoria del brazo 6-DOF, movimiento del chasis Mecanum, color de LED RGB y tono del buzzer).

```json
{
  "name": "gatekeeper_approve",
  "mood": "approved"
}
```

**Catálogo completo de gestos soportados (`21` coreografías)**:
- **Demo A · Repo Roaster**: `facepalm`, `trash_toss`, `chef_kiss`, `suspicious_inspect`, `victory_spin`
- **Demo B · CI/CD Gatekeeper**: `gatekeeper_hold`, `gatekeeper_approve`, `gatekeeper_reject`
- **Demo C · Spatial Bug Hunter**: `point_cloud_run`, `point_gemini_live`, `point_firestore`
- **Demo D · Bumblebee Radio**: `bumblebee_hype`, `bumblebee_groove`, `bumblebee_rock_out`, `bumblebee_romance`, `bumblebee_sad_droop`, `bumblebee_sassy`
- **Generales**: `nod_yes`, `shake_no`, `wave_hello`, `home`

### 3. `POST /arm`
Posiciona múltiples servos del brazo en una trayectoria interpolada a `40 Hz`. Todos los pulsos pasan por `clamp_servo_pulse` antes de enviarse al hardware.

```json
{
  "duration_ms": 450,
  "servos": [
    { "id": 1, "position": 500 },
    { "id": 2, "position": 430 },
    { "id": 3, "position": 310 },
    { "id": 4, "position": 380 },
    { "id": 5, "position": 500 },
    { "id": 10, "position": 680 }
  ]
}
```

### 4. `POST /servo/jog`
Ajusta de forma incremental el pulso de un servo individual (`id` ∈ `{1, 2, 3, 4, 5, 10}`).

```json
{
  "id": 10,
  "delta": -40
}
```

### 5. `POST /cmd_vel`
Comanda velocidades lineales (`m/s`) y angulares (`rad/s`) en el chasis Mecanum. Protegido por:
1. **Escudo LiDAR**: si `lidar.front_m < 0.28` y `linear_x > 0`, el puente fuerza `linear_x = 0.0`.
2. **Deadman Watchdog (`600 ms`)**: detiene los 4 motores automáticamente al expirar `duration_ms` o si no se reciben nuevos comandos en `600 ms`.

```json
{
  "linear_x": 0.14,
  "linear_y": 0.0,
  "angular_z": 0.0,
  "duration_ms": 550
}
```

### 6. `POST /hud`, `POST /rgb`, `POST /buzzer`, `POST /simulate/lidar`, `POST /scene/reset`, `POST /stop`, `GET /camera/frame`
- **`POST /hud`**: Actualiza el estado visual de la pantalla integrada (`/face`): `{ speaking, listening, headline, subtext, mood }`.
- **`POST /rgb`**: Define el color de los LEDs WS2812 de la placa STM32: `{ r, g, b }` (`0..255`).
- **`POST /buzzer`**: Activa el buzzer piezoeléctrico: `{ freq_hz, on_ms, off_ms, repeat }`.
- **`POST /simulate/lidar`**: Inyecta una distancia frontal simulada (`front_m` en `[0.05, 5.0]`) para probar el freno autónomo.
- **`POST /scene/reset`**: Detiene los motores, reinicia la odometría `(0, 0, 0)`, lleva el brazo a `home` y restaura `held_object = "deploy_key"`.
- **`POST /stop`**: Parada de emergencia inmediata de chasis y regreso del brazo a `home`.
- **`GET /camera/frame`**: Devuelve el último frame `image/jpeg` de la cámara 3D Aurora 930 (o un frame `image/svg+xml` sintético en modo simulador).

---

## Parte II · Especificación Formal del API HTTP REST

### Convenciones del Protocolo
- **Base URL**: `http://localhost:9000` (Simulador en laptop) o `http://<IP_DEL_ROBOT>:9000` (Jetson Orin Nano).
- **Content-Type de Peticiones**: `application/json; charset=utf-8`.
- **CORS**: Habilitado para cualquier origen (`Access-Control-Allow-Origin: *`, métodos `GET, POST, OPTIONS`).
- **Códigos de Estado HTTP Estándar**:
  - `200 OK`: Comando aceptado, validado por los guardrails físicos y aplicado al estado del robot. Devuelve `ActionResponse` o `TelemetryState`.
  - `101 Switching Protocols`: Upgrade exitoso en `GET /ws`.
  - `400 Bad Request`: JSON malformado en el cuerpo de la petición.
  - `422 Unprocessable Entity`: Tipos de datos inválidos o campos obligatorios faltantes según el esquema de deserialización `serde` de Axum.

### Tabla Formal de Endpoints HTTP

| Método | Ruta | Request Schema | Response `200 OK` Schema | Idempotente | Guardrails Aplicados en Rust |
|---|---|---|---|---|---|
| `GET` | `/status` | — | `TelemetryState` (`application/json`) | Sí | Lectura sin bloqueo de estado actual. |
| `GET` | `/camera/frame` | Query opcional `?t=<ms>` | Binario `image/jpeg` o `image/svg+xml` | Sí | Fallback automático a SVG si no hay cámara física. |
| `GET` | `/ws` | Cabeceras `Upgrade: websocket` | `101 Switching Protocols` | Sí | Broadcast a `20 Hz` (`50 ms`) + recepción de `WsClientCommand`. |
| `POST` | `/cmd_vel` | `CmdVelRequest` | `ActionResponse` | No | `linear_x, linear_y ∈ [-0.25, 0.25]`, `angular_z ∈ [-1.2, 1.2]`, `duration_ms ≤ 4000`, freno si `front_m < 0.28`. |
| `POST` | `/arm` | `ArmRequest` | `ActionResponse` | Sí | Cada servo pasa por `clamp_servo_pulse(id, position)`. |
| `POST` | `/servo/jog` | `ServoJogRequest` | `ActionResponse` | No | El pulso resultante se recorta al rango seguro del servo `id`. |
| `POST` | `/gesture` | `GestureRequest` | `ActionResponse` | No | Cancela trayectoria previa e inicia secuencia asíncrona en `tokio`. |
| `POST` | `/hud` | `HudUpdateRequest` | `ActionResponse` | Sí | Actualización parcial (*patch*) de campos no nulos. |
| `POST` | `/rgb` | `RgbRequest` | `ActionResponse` | Sí | Valores `u8` (`0..255`). |
| `POST` | `/buzzer` | `BuzzerRequest` | `ActionResponse` | No | Valores `u16` con defaults seguros (`1900 Hz`, `150 ms`). |
| `POST` | `/simulate/lidar` | `LidarSimRequest` | `ActionResponse` | Sí | `front_m` recortado a `[0.05, 5.0]` m; activa `obstacle_alert` si `< 0.35` m. |
| `POST` | `/scene/reset` | Vacío | `ActionResponse` | Sí | Pone `vx=vy=wz=0`, `x=y=yaw=0` y servos en pose `home`. |
| `POST` | `/stop` | Vacío | `ActionResponse` | Sí | Parada inmediata de motores Mecanum y retorno a `home`. |

---

### Esquemas Formales de Datos (JSON Schema Draft 2020-12)

#### 1. `TelemetryState`
Objeto devuelto por `GET /status`, embebido en `ActionResponse.telemetry` y emitido a `20 Hz` por `WS /ws`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "TelemetryState",
  "type": "object",
  "required": [
    "backend", "connected", "battery_mv", "servos", "target_servos",
    "rgb", "active_gesture", "mood", "held_object", "pointed_totem",
    "speaking", "listening", "hud_headline", "hud_subtext",
    "odometry", "lidar", "last_command_ms_ago", "timestamp_ms"
  ],
  "properties": {
    "backend": { "type": "string", "examples": ["mock-simulator", "ros2-humble", "stm32-board (/dev/rrc @ 1Mbps)"] },
    "connected": { "type": "boolean" },
    "battery_mv": { "type": "integer", "minimum": 0, "maximum": 15000, "description": "Voltaje de batería 3S Li-ion en milivoltios." },
    "servos": {
      "type": "object",
      "description": "Pulsos actuales interpolados (IDs '1'..'5' y '10').",
      "additionalProperties": { "type": "integer", "minimum": 100, "maximum": 900 }
    },
    "target_servos": {
      "type": "object",
      "description": "Pulsos objetivo hacia los que interpola el loop de 40 Hz.",
      "additionalProperties": { "type": "integer", "minimum": 100, "maximum": 900 }
    },
    "rgb": {
      "type": "array",
      "items": { "type": "integer", "minimum": 0, "maximum": 255 },
      "minItems": 3,
      "maxItems": 3
    },
    "active_gesture": { "type": "string" },
    "mood": { "type": "string" },
    "held_object": { "type": ["string", "null"] },
    "pointed_totem": { "type": ["string", "null"] },
    "speaking": { "type": "boolean" },
    "listening": { "type": "boolean" },
    "hud_headline": { "type": "string" },
    "hud_subtext": { "type": "string" },
    "odometry": {
      "type": "object",
      "required": ["x_m", "y_m", "yaw_rad", "vx", "vy", "wz"],
      "properties": {
        "x_m": { "type": "number" },
        "y_m": { "type": "number" },
        "yaw_rad": { "type": "number" },
        "vx": { "type": "number" },
        "vy": { "type": "number" },
        "wz": { "type": "number" }
      }
    },
    "lidar": {
      "type": "object",
      "required": ["front_m", "left_m", "right_m", "back_m", "obstacle_alert"],
      "properties": {
        "front_m": { "type": "number", "minimum": 0.05, "maximum": 5.0 },
        "left_m": { "type": "number" },
        "right_m": { "type": "number" },
        "back_m": { "type": "number" },
        "obstacle_alert": { "type": "boolean" }
      }
    },
    "last_command_ms_ago": { "type": "integer", "minimum": 0 },
    "timestamp_ms": { "type": "integer", "minimum": 0 }
  }
}
```

#### 2. `ActionResponse`
Respuesta estándar de todos los endpoints `POST`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ActionResponse",
  "type": "object",
  "required": ["status", "action", "telemetry"],
  "properties": {
    "status": { "type": "string", "const": "ok" },
    "action": { "type": "string", "description": "Resumen legible de la operación ejecutada." },
    "telemetry": { "$ref": "#/definitions/TelemetryState" }
  }
}
```

#### 3. Rangos Físicos Seguros de `clamp_servo_pulse(id, pulse)`

| Servo ID | Articulación | Pulso Central | Mínimo Permitido | Máximo Permitido | Motivo del Guardrail Físico |
|---|---|---|---|---|---|
| `1` | Base (`joint1` yaw) | `500` | `120` | `880` | Evita torsión del cableado interno del brazo. |
| `2` | Hombro (`joint2` pitch) | `500` | `220` | `780` | Protege contra impacto mecánico con la torre del LiDAR MS200. |
| `3` | Codo (`joint3` pitch) | `500` | `150` | `850` | Evita auto-colisión del antebrazo con el chasis. |
| `4` | Muñeca (`joint4` pitch) | `500` | `150` | `850` | Protege la carcasa de la cámara 3D Aurora 930. |
| `5` | Rotación muñeca (`joint5` roll) | `500` | `100` | `900` | Rango seguro de giro continuo de la pinza. |
| `10` | Pinza paralela (`r_joint`) | `500` | `200` | `750` | `220` = abierta; `680` = cerrada sujetando la llave sin sobrecorriente. |

---

## Parte III · Especificación Formal del Canal WebSocket (`ws://<HOST>:9000/ws`)

### 1. Mensajes Servidor → Cliente (`20 Hz` / cada `50 ms`)
- Al establecerse la conexión, el servidor envía inmediatamente un mensaje de texto UTF-8 con el `TelemetryState` actual.
- Posteriormente, cada `2` ticks del loop cinemático de `40 Hz` (`2 × 25 ms = 50 ms`), emite un frame JSON serializando `TelemetryState`.

### 2. Mensajes Cliente → Servidor (`WsClientCommand`)
El cliente puede enviar tramas JSON etiquetadas internamente mediante el discriminador `"op"` (`snake_case`):

| Valor de `"op"` | Esquema del Payload JSON | Efecto en `rosorin-bridge` |
|---|---|---|
| `"cmd_vel"` | `{ "op": "cmd_vel", "linear_x": 0.14, "linear_y": 0.0, "angular_z": 0.0, "duration_ms": 500 }` | Actualiza velocidad del chasis con parada automática tras `duration_ms`. |
| `"gesture"` | `{ "op": "gesture", "name": "bumblebee_groove", "mood": "dancing" }` | Inicia la coreografía indicada. |
| `"arm"` | `{ "op": "arm", "duration_ms": 400, "servos": [{ "id": 1, "position": 500 }] }` | Define pulsos objetivo para los servos indicados. |
| `"jog"` | `{ "op": "jog", "id": 10, "delta": -35 }` | Incrementa o decrementa el pulso del servo `id`. |
| `"reset_scene"` | `{ "op": "reset_scene" }` | Restaura odometría y pose `home`. |
| `"stop"` | `{ "op": "stop" }` | Parada de emergencia inmediata. |

---

## Parte IV · Declaraciones Formales de Herramientas en Gemini 3.8 Live

Definidas en [`web/src/lib/gemini-live.ts`](../web/src/lib/gemini-live.ts) y [`web/src/lib/bumblebee-radio.ts`](../web/src/lib/bumblebee-radio.ts):

| Nombre de Tool | Demo | Parámetros Requeridos | Traducción a `rosorin-bridge` |
|---|---|---|---|
| `express_verdict` | Demo A (`/demos/roaster`) | `gesture` (`enum`), `mood` (`string`), `verdict_headline` (`string`) | `POST /hud` + `POST /gesture` |
| `release_deploy_key` | Demo B (`/demos/gatekeeper`) | `decision` (`"approve" \| "reject"`), `reason_es` (`string`) | `POST /hud` + `POST /gesture` (`gatekeeper_approve` o `gatekeeper_reject`) |
| `point_at_service_totem` | Demo C (`/demos/bughunter`) | `service` (`"cloud_run" \| "gemini_live" \| "firestore"`), `diagnosis_es` (`string`) | `POST /hud` + `POST /gesture` (`point_cloud_run`, `point_gemini_live` o `point_firestore`) |
| `move_chassis` | Todos | `direction` (`"forward" \| "backward" \| "strafe_left" \| "strafe_right" \| "spin_left" \| "spin_right"`), `duration_ms` (`number`, opcional) | `POST /cmd_vel` |
| `play_radio_sequence` | Demo D (`/demos/bumblebee`) | `clip_ids` (`string[]`), `dance_gesture` (`bumblebee_*`), `radio_caption` (`string`) | Reproduce estática FM + clips MP3 + `POST /gesture` + `POST /hud` |
