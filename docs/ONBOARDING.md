# Guía de Onboarding y Ejecución

![Modos de Ejecución: Simulador en Laptop vs Conexión a Robot Físico](./assets/onboarding-modes.svg)

Puedes ejecutar el proyecto en **dos modos** utilizando exactamente el mismo código TypeScript y el mismo binario compilado en Rust (`rosorin-bridge`):

1. **Modo 1 · Simulador 3D en tu Laptop (`--mock`)**: Ejecuta la cinemática Mecanum, la interpolación de los 6 servos y los sensores simulados en tu propia laptop sin necesidad del robot físico.
2. **Modo 2 · Laptop Conectada al Robot Físico por Wi-Fi (`--robot-ip <IP>`)**: La interfaz web, el visor 3D a `60 FPS` y la captura de micrófono corren en tu laptop (`http://localhost:3000`) y envían los comandos físicos por Wi-Fi hacia el puente del robot (`http://<IP_DEL_ROBOT>:9000`).

---

## 1. Requisitos Previos

- **Node.js** `>= 22.6` y `npm`
- **Rust** (`cargo` `>= 1.75`) — `./run.sh` lo instala automáticamente si no está presente.
- **API Key de Gemini**: Puedes ingresarla directamente en la barra superior de la aplicación web (se guarda en `localStorage` bajo `rosorin_gemini_api_key`) o copiar `web/.env.example` a `web/.env.local` para desarrollo local.

---

## 2. Modo 1: Correr Todo en tu Laptop (Simulador 3D)

```bash
git clone https://github.com/ykro/rosorin-jsconf.git
cd rosorin-jsconf
./run.sh --mock
```

Este comando levanta automáticamente dos procesos locales:
- **Puente cinemático en Rust (`cargo run -- --backend mock`)**: `http://localhost:9000` (con stream WebSocket a `20 Hz` en `ws://localhost:9000/ws`).
- **Aplicación Web Next.js 15**: `http://localhost:3000`.

### Rutas disponibles en el navegador
- `http://localhost:3000` — **Hub Completo con Clon 3D** (control manual de servos `1..5` y pinza `10`, cruceta Mecanum, telemetría LiDAR y acceso a los 4 demos).
- `http://localhost:3000/robot` — **Hub Ligero sin 3D** (controles de hardware de alto contraste sin carga WebGL).
- `http://localhost:3000/demos/roaster` — **Demo A · Repo Roaster**
- `http://localhost:3000/demos/gatekeeper` — **Demo B · Physical CI/CD Gatekeeper**
- `http://localhost:3000/demos/bughunter` — **Demo C · Spatial Bug Hunter**
- `http://localhost:3000/demos/bumblebee` — **Demo D · Modo Bumblebee Radio** (`168 clips`: `95 ES` / `73 EN`)
- `http://localhost:3000/face` — **Rostro Expresivo y Pantalla Táctil Integrada**
- `http://localhost:3000/props` — **Plantillas Imprimibles 1:1** (`rosorin-stage-props-print.pdf`).

---

## 3. Modo 2: Conectar tu Laptop al Robot Físico por Wi-Fi

### Paso 1: Iniciar el puente en el Jetson Orin Nano del Robot
Conéctate por SSH al Jetson Orin Nano del ROSOrin Pro y ejecuta:

```bash
cd ~/Desktop/rosorin-jsconf
git pull
./run.sh
```

En el robot, `./run.sh` detecta automáticamente el entorno **ROS 2 Humble** y la placa **STM32** (`/dev/rrc` @ `1 Mbps`), libera los servicios en segundo plano que acaparan el puerto serial y levanta `rosorin-bridge` en el puerto `:9000`.

Puedes verificar desde tu laptop que el puente del robot responde consultando su estado:

```bash
curl http://<IP_DEL_ROBOT>:9000/status
```

### Paso 2: Levantar la Web en tu Laptop con `--robot-ip`
En tu laptop, ejecuta `./run.sh` pasando la dirección IP del robot con la bandera `--robot-ip` (o `--ip`):

```bash
./run.sh --robot-ip <IP_DEL_ROBOT>
```

También puedes cambiar el puente en caliente desde cualquier ruta del navegador agregando el parámetro `?bridge=`:
- `http://localhost:3000?bridge=http://<IP_DEL_ROBOT>:9000`
- `http://localhost:3000/robot?bridge=http://<IP_DEL_ROBOT>:9000`

---

## 4. Banderas Soportadas por `./run.sh`

| Bandera | Ejemplo | Descripción |
|---|---|---|
| `--mock` | `./run.sh --mock` | Fuerza el simulador cinemático en memoria (`--backend mock`) en `localhost:9000`. |
| `--robot-ip <IP>` / `--ip <IP>` | `./run.sh --robot-ip 10.0.0.42` | Inicia el frontend en tu laptop (`localhost:3000`) conectado al `robot-bridge` remoto del robot en `<IP>:9000`. |
| `--ros2` | `./run.sh --ros2` | Fuerza el backend de tópicos de ROS 2 Humble (`ros2_worker.py`). |
| `--serial` | `./run.sh --serial` | Fuerza comunicación serial binaria directa con la placa STM32 (`/dev/rrc` a `1 Mbps`). |
| `--bridge-only` | `./run.sh --bridge-only` | Compila y ejecuta únicamente el servidor `rosorin-bridge` en Rust sin iniciar Next.js. |
| `--web-port <PORT>` | `./run.sh --web-port 3001` | Cambia el puerto HTTP de la aplicación Next.js (por defecto `3000`). |
| `--bridge-port <PORT>` | `./run.sh --bridge-port 9001` | Cambia el puerto HTTP/WS de `rosorin-bridge` (por defecto `9000`). |

> [!IMPORTANT]
> **¿Por qué abrir `http://localhost:3000` en la laptop usando `--robot-ip` en lugar de abrir la IP remota en el navegador?**
> Los navegadores modernos restringen `navigator.mediaDevices.getUserMedia` (el micrófono para Gemini Live) a contextos seguros (`https://` o `http://localhost`). Al correr `./run.sh --robot-ip <IP_DEL_ROBOT>` en tu laptop, el navegador opera sobre `http://localhost:3000` con acceso total al micrófono y GPU local a `60 FPS`, mientras despacha las acciones físicas por Wi-Fi a `<IP_DEL_ROBOT>:9000`.
