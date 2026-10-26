# Arquitectura del Sistema

![Capas del Sistema y Loops Concurrentes en Tiempo Real](./assets/layers-loops.svg)

Este documento describe la arquitectura de **4 capas** implementada en **TypeScript (Next.js 15 + Three.js) + Rust (`axum` / `tokio` / `serialport`) + Python (ROS 2 Humble) + STM32**, el desacoplamiento temporal entre la nube y los motores, y el funcionamiento del rostro interactivo en la pantalla táctil integrada del robot (`/face`).

---

## 1. Distribución de Responsabilidades por Capa

| Capa | Lenguaje / Stack | Dónde corre | Escala Temporal | Responsabilidad Principal |
|---|---|---|---|---|
| **Capa 4 · Cloud AI** | `gemini-3.8-live` (`BidiGenerateContent` WSS) | Google Cloud | `~250 – 450 ms` | Comprensión de voz nativa (`16 kHz` PCM), síntesis de voz expresiva (`24 kHz` PCM), visión a `1 Hz` y emisión de llamadas a herramientas (`NON_BLOCKING`). |
| **Capa 3 · Cockpit Web & Clon 3D** (`web/`) | **TypeScript**, Next.js 15 (`15.5.28`), React 19, Three.js, `@google/genai` | Laptop (`localhost:3000`) o pantalla del robot | `60 FPS` (`16.6 ms`) | Captura de micrófono con compuerta acústica de `1,200 ms`, vaciado de cola de audio en `< 20 ms` ante *barge-in*, jukebox musical de Bumblebee (`168 clips`) y renderizado del clon 3D con 16 mallas CAD `.stl`. |
| **Capa 2 · Puente Determinista** (`robot-bridge/`) | **Rust** (`axum`, `tokio`, `serialport`) | Jetson Orin Nano (`:9000`) o Laptop (`--backend mock`) | Loop `40 Hz` (`25 ms`) · WS `20 Hz` (`50 ms`) | Interpolación suave de los 6 servos (`900 pulsos/s`), clamping de límites mecánicos por articulación (`J1: 120..880`, `J2: 220..780`, `J3/J4: 150..850`, `J5: 100..900`, `ID 10: 200..750`), *deadman watchdog* (`600 ms`) y freno autónomo por LiDAR (`< 0.28 m`). |
| **Capa 1 · Sensores y Actuadores** | **ROS 2 Humble** + **STM32F407** (`/dev/rrc`) | Robot físico Hiwonder ROSOrin Pro | UART `1 Mbps` (`< 2 ms`) | Control PWM de los 4 motores Mecanum con encoders, bus serial de los 6 servos (`IDs 1..5` + pinza `ID 10`), LiDAR MS200 (`/scan` en `ros2_worker.py`) y cámara 3D Aurora 930. |

---

## 2. Decisiones Clave de Arquitectura

### ¿Por qué el puente de hardware (`robot-bridge`) está escrito en Rust?
1. **Concurrencia determinista sin pausas de *garbage collector* ni bloqueos del GIL**:
   - El servidor debe interpolar simultáneamente las posiciones de 6 servos cada `25 ms` (`40 Hz`), transmitir el estado completo (`TelemetryState`) por WebSocket cada `50 ms` (`20 Hz`), atender peticiones HTTP REST y vigilar el *deadman watchdog* de las ruedas Mecanum cada `600 ms`. Con `tokio` y `Arc<Mutex<TelemetryState>>` en Rust, estos loops corren sin *jitter*.
2. **Guardrails físicos compilados entre el LLM y los motores**:
   - El modelo multimodal nunca escribe directamente en `/dev/rrc` ni en los tópicos de ROS 2. Todo comando atraviesa funciones de validación en Rust (`is_valid_servo_id`, `clamp_servo_pulse`, límite de velocidades lineales `[-0.25, 0.25] m/s`, angulares `[-0.80, 0.80] rad/s`, duración `100..2500 ms` y bloqueo de avance cuando `lidar.front_m < 0.28`).
3. **Un único binario nativo para laptop (`mock`) y robot (`ros2` / `serial`)**:
   - En la laptop, `rosorin-bridge --backend mock` ejecuta exactamente las mismas ecuaciones cinemáticas y coreografías que en el Jetson Orin Nano, garantizando que lo que se prueba en el clon 3D se comporte igual en el escenario.

### ¿Por qué correr la interfaz web en la laptop conectada al robot por Wi-Fi?
1. **Contexto seguro para `Web Audio API`**: Los navegadores permiten `navigator.mediaDevices.getUserMedia` en `http://localhost:3000` sin requerir certificados TLS locales.
2. **Descarga gráfica WebGL**: La laptop renderiza las 16 mallas `.stl` en Three.js a `60 FPS`, dejando la CPU y GPU del Jetson Orin Nano dedicadas al procesamiento de sensores ROS 2 y control en tiempo real.

---

## 3. Supresión Acústica de Eco, *Barge-In* y Sanitización (`web/src/lib/gemini-live.ts`)

En un agente físico, cada acción del robot contamina sus propios sensores: hablar por el altavoz o mover los 6 servos genera ruido acústico y vibración que el micrófono capta. Para resolverlo implementamos tres mecanismos coordinados:

1. **Ventana de supresión post-servo (`1,200 ms`) y compuerta de ruido**:
   - Al disparar cualquier herramienta física o coreografía en los demos (incluyendo Bumblebee Radio), se activa una ventana de supresión acústica de **`1,200 ms`** (`motionSuppressUntil = Date.now() + 1200`) y una compuerta RMS (`normalizedLevel < 0.09`). Durante esa ventana se envían tramas PCM en cero para mantener vivo el reloj del stream sin que el robot se interrumpa con el sonido de sus propios engranajes.
2. **Interrupción instantánea (*Voice Barge-In* en `< 20 ms`)**:
   - Si el usuario habla con volumen alto (`normalizedLevel > 0.36`) mientras el robot habla, o si llega `serverContent.interrupted`, `flushAudioQueueOnBargeIn()` detiene inmediatamente todos los nodos `AudioBufferSourceNode` en vuelo y reinicia el cursor de reproducción.
3. **Fijación de idioma y filtro de alfabeto (`sanitizeSpanishChunk`)**:
   - Se configura `speechConfig.languageCode = 'es-US'` y se descartan alucinaciones del ASR en alfabetos no latinos provocadas por ruido blanco de sala.

---

## 4. Rostro Cinético y Superficie Táctil Integrada (`/face`)

El Hiwonder ROSOrin Pro cuenta con una pantalla táctil capacitiva de 7 pulgadas (`1024×600` / `1280×720 @ 60 Hz` sobre `DP-1`, controlador `USB2IIC_CTP_CONTROL`). La ruta `/face` convierte esa pantalla en la interfaz expresiva del robot:

1. **Ojos geométricos sincronizados a `20 Hz` con `joint1` y el estado emocional**:
   - La mirada sigue el ángulo real de la base del brazo (`servo ID 1`), cambia de expresión según el `mood` activo (`roasting`, `approved`, `rejected`, `guarding`, `dancing`) y anima un ecualizador cuando el robot habla o reproduce canciones en el **Modo Bumblebee Radio**.
2. **Placa de veredicto y teleprompter musical (`/hud`)**:
   - Muestra en tipografía de alto contraste el titular de cada decisión (`DEPLOY APROBADO`, `CULPABLE: CLOUD RUN`) o la letra y frecuencia FM de la canción activa en `/demos/bumblebee`.
3. **Controles táctiles directos sobre el robot**:
   - Permite iniciar una sesión de voz, abrir/cerrar la pinza (`Servo ID 10`: `220` ↔ `680`) para colocar la llave física de deploy, o ejecutar una parada de emergencia (`POST /stop`) con un solo toque en la pantalla de 7".
