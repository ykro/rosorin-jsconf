# Embodied AI con Gemini 3.8 Live, TypeScript y Rust

[![Hub en Vivo](https://img.shields.io/badge/Hub_en_Vivo-jsconfmx26.web.app-EB6C36?style=for-the-badge)](https://jsconfmx26.web.app)
[![Slides](https://img.shields.io/badge/Slides-jsconfmx26.web.app%2Fslides-0E1117?style=for-the-badge)](https://jsconfmx26.web.app/slides)
[![Simulador 3D](https://img.shields.io/badge/Simulador_3D-jsconfmx26.web.app%2Fdemo-1A73E8?style=for-the-badge)](https://jsconfmx26.web.app/demo)
[![Modelo](https://img.shields.io/badge/Gemini_API-gemini--3.8--live-2E5AA8?style=for-the-badge)](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live)

![Arquitectura End-to-End con Gemini 3.8 Live y Rust](./docs/assets/architecture.svg)

Repositorio oficial de la charla **«De Web a Physical AI: Agentes Físicos con Gemini Live y JavaScript»** por **Adrián Catalán (`@adriancs.tech`)**.

Este proyecto demuestra cómo desarrolladores web pueden construir agentes de **Physical AI** en tiempo real combinando:
- **Gemini 3.8 Live (`gemini-3.8-live`)** por WebSocket bidireccional con audio nativo (`16 kHz` entrada / `24 kHz` salida), compuerta acústica post-servo de `1,200 ms` y ejecución de herramientas físicas no bloqueantes (`NON_BLOCKING`).
- **Clon 3D interactivo en Three.js (`60 FPS`)** construido a partir de las 16 mallas CAD `.stl` oficiales del fabricante, sincronizado a `20 Hz` con el robot físico o el simulador.
- **Puente determinista en Rust (`robot-bridge :9000`)** con un loop cinemático de `40 Hz` (`25 ms`), guardrails mecánicos por articulación (`J1: 120..880`, `J2: 220..780`, `J3/J4: 150..850`, `J5: 100..900`, `Pinza ID 10: 200..750`), freno autónomo por LiDAR (`< 0.28 m`) y *deadman watchdog* (`600 ms`).
- **Hiwonder ROSOrin Pro** sobre **NVIDIA Jetson Orin Nano**, **ROS 2 Humble** y co-controlador **STM32** (`1 Mbps` UART).

---

## Hub en Línea, Slides y Simulador 3D (Firebase Hosting)

- **Hub Principal**: [**https://jsconfmx26.web.app**](https://jsconfmx26.web.app)
- **Presentación Interactiva (`/slides`)**: [**https://jsconfmx26.web.app/slides**](https://jsconfmx26.web.app/slides) (fuente en [`slides/index.html`](./slides/index.html))
- **Simulador 3D y 4 Demos en Vivo (`/demo`)**: [**https://jsconfmx26.web.app/demo**](https://jsconfmx26.web.app/demo) (corre en el navegador con Three.js a `60 FPS`, el catálogo de 168 clips de Bumblebee Radio y Gemini 3.8 Live sin necesidad de instalar nada).

---

## Arranque Rápido

Puedes ejecutar todo el sistema en tu **laptop sin hardware físico** (usando el simulador cinemático en Rust + el clon 3D en Three.js) o conectarte desde tu laptop a un **ROSOrin Pro físico** en la misma red Wi-Fi mediante la bandera `--robot-ip`.

### Requisitos
- **Node.js** `>= 22.6` y `npm`
- **Rust** (`cargo >= 1.75`) — `./run.sh` lo instala automáticamente si no está disponible.

### Opción 1 · Simulador 3D en tu Laptop (Sin Robot Físico)

```bash
git clone https://github.com/ykro/rosorin-jsconf.git
cd rosorin-jsconf
./run.sh --mock
```

- Compila e inicia automáticamente `robot-bridge` en modo simulador (`--backend mock`) en `http://localhost:9000`.
- Levanta la aplicación web en `http://localhost:3000`.

### Opción 2 · Laptop Conectada al Robot Físico por Wi-Fi (`--robot-ip`)

1. En el **Jetson Orin Nano** del robot inicia el puente de hardware:
   ```bash
   ./run.sh
   ```
2. En tu **laptop**, inicia la interfaz apuntando a la IP del robot con la bandera `--robot-ip`:
   ```bash
   ./run.sh --robot-ip <IP_DEL_ROBOT>
   ```
   Esto configura automáticamente `NEXT_PUBLIC_BRIDGE_URL=http://<IP_DEL_ROBOT>:9000` y abre `http://localhost:3000` en tu laptop (permitiendo acceso nativo al micrófono Web Audio y renderizado WebGL a `60 FPS` mientras los comandos mueven el robot real por Wi-Fi).

---

## Los 4 Demos Interactivos

| Demo | Ruta | Herramienta Física / Mecánica | Qué demuestra |
|---|---|---|---|
| **Demo A · Repo Roaster** | `/demos/roaster` | `express_verdict` (`facepalm`, `trash_toss`, `chef_kiss`, `suspicious_inspect`, `victory_spin`) | Analiza repositorios de GitHub y coordina gestos de 6 grados de libertad y desplazamientos Mecanum mientras conversa en vivo. |
| **Demo B · CI/CD Gatekeeper** | `/demos/gatekeeper` | `release_deploy_key` (Pinza `Servo ID 10`: cerrado `680` → abierto `220`) | El robot sostiene físicamente la llave de producción y decide si gira hacia la bandeja verde (`joint1=680`) o roja (`joint1=260`) para soltarla. |
| **Demo C · Spatial Bug Hunter** | `/demos/bughunter` | `point_at_service_totem` (`point_cloud_run`, `point_gemini_live`, `point_firestore`) | Al recibir un incidente de producción, el chasis Mecanum hace *strafe* lateral (`Y = ±20 cm`) y apunta físicamente al tótem del servicio culpable. |
| **Demo D · Bumblebee Radio** | `/demos/bumblebee` | `play_radio_sequence` + 6 bailes `bumblebee_*` + **168 clips (95 ES / 73 EN)** | Conversación continua con un solo botón donde el robot baila y responde **exclusivamente sintonizando fragmentos musicales** en español e inglés. |

> [!NOTE]
> Por cumplimiento de derechos de autor, los archivos de audio `.mp3` no se distribuyen en el repositorio público de Git. El catálogo de metadatos y letras sincronizadas (`168 clips`: `95 en español` y `73 en inglés`) se incluye en [`web/public/songs/catalog.json`](./web/public/songs/catalog.json), y los `.mp3` locales pueden colocarse en `web/public/songs/clips/` (con síntesis automática de respaldo cuando no están presentes).

### Vistas adicionales del sistema
- `/` — **Cockpit Completo con Clon 3D**: Panel de control de servos, chasis Mecanum, telemetría LiDAR y visor Three.js en vivo.
- `/robot` — **Consola Ligera (Sin WebGL)**: Diseñada para pruebas rápidas de hardware sin carga de GPU.
- `/face` — **Rostro Expresivo y Superficie Táctil (Display 7" del Robot)**: Ojos geométricos reactivos a `joint1`, estado de voz, letras de canciones en modo Bumblebee y botones táctiles de emergencia.
- `/props` — **Props Físicos Imprimibles 1:1**: Descarga de [`docs/rosorin-stage-props-print.pdf`](./docs/rosorin-stage-props-print.pdf) (llave de deploy calibrada para la pinza `ID 10`, bandejas y tótems).

---

## Skills para Agentes de Código (`skills/`)

El repositorio incluye **3 skills reutilizables** que documentan las restricciones físicas, el protocolo de audio PCM y la cinemática 3D para evitar alucinaciones al programar con agentes:

| Skill | Archivo | Qué resuelve |
|---|---|---|
| **`rosorin-pro`** | [`skills/rosorin-pro/SKILL.md`](./skills/rosorin-pro/SKILL.md) | Mapeo real de servos (`IDs 1..5` brazo y **`ID 10` pinza**, nunca `ID 6`), límites mecánicos (`joint2: 220..780` para no golpear la torre LiDAR, `pinza ID 10: 200..750`), protocolo binario STM32 (`0xAA 0x55` a `1 Mbps`) y tópicos de ROS 2 Humble. |
| **`gemini-live-js`** | [`skills/gemini-live-js/SKILL.md`](./skills/gemini-live-js/SKILL.md) | Ciclo de vida WebSocket con `gemini-3.8-live`, streaming PCM `16 kHz` / `24 kHz`, *barge-in* en `< 20 ms`, compuerta acústica de `1,200 ms` post-servo y *tool calling* asíncrono. |
| **`threejs-urdf-twin`** | [`skills/threejs-urdf-twin/SKILL.md`](./skills/threejs-urdf-twin/SKILL.md) | Construcción del clon 3D en Three.js desde las 16 mallas `.stl` del fabricante, recálculo de normales (`computeVertexNormals()`), cadena cinemática `J1..J5` + mecanismo paralelo de 4 barras de la pinza e interpolación a `60 FPS` desde WebSocket a `20 Hz`. |

---

## Documentación Técnica

Todos los documentos incluyen diagramas vectoriales de arquitectura al inicio:

- [**Guía de Onboarding y Modos de Ejecución (`docs/ONBOARDING.md`)**](./docs/ONBOARDING.md) — Ejecución en laptop (`--mock`) y conexión por Wi-Fi al robot (`--robot-ip`).
- [**Arquitectura del Sistema y Loops en Tiempo Real (`docs/ARCHITECTURE.md`)**](./docs/ARCHITECTURE.md) — Desacoplamiento temporal de 4 capas, por qué Rust + ROS 2, supresión acústica de eco (`1,200 ms`) y pantalla táctil `/face`.
- [**Rust para Web Developers (`docs/RUST_FOR_WEB_DEVS.md`)**](./docs/RUST_FOR_WEB_DEVS.md) — Explicación directa con 3 diagramas SVG de cómo funciona `robot-bridge` (Tokio, Axum, `Arc<Mutex<TelemetryState>>` y las 4 barreras de seguridad física) para desarrolladores de TypeScript/Node.js.
- [**Especificación Formal del API (`docs/API.md`)**](./docs/API.md) — Explicación detallada + especificación formal de endpoints HTTP REST, esquemas JSON, códigos de estado, protocolo WebSocket (`20 Hz`) y declaraciones de herramientas de Gemini Live.
- [**Contrato OpenAPI 3.1.0 (`docs/openapi.yaml`)**](./docs/openapi.yaml) — Especificación formal OpenAPI 3.1 del servidor `rosorin-bridge`.
- [**Guía de Demos Interactivos (`docs/DEMOS.md`)**](./docs/DEMOS.md) — Flujo paso a paso de los Demos A, B, C y D (Modo Bumblebee Radio).

---

## Estructura del Repositorio

```text
rosorin-jsconf/
├── run.sh                        # Script unificado (--mock | --robot-ip <IP> | --serial | --ros2)
├── firebase.json                 # Configuración de despliegue en Firebase Hosting (jsconfmx26.web.app)
├── LICENSE                       # Licencia MIT (código) + atribución de mallas CAD Hiwonder
├── slides/                       # Presentación HTML5 1920x1080 desplegada en jsconfmx26.web.app/slides
│   ├── index.html
│   └── assets/
├── docs/                         # Documentación técnica + diagramas SVG + OpenAPI 3.1
│   ├── ONBOARDING.md
│   ├── ARCHITECTURE.md
│   ├── RUST_FOR_WEB_DEVS.md
│   ├── API.md
│   ├── openapi.yaml
│   ├── DEMOS.md
│   └── assets/                   # 8 diagramas vectoriales (.svg y fuente .html)
├── skills/                       # 3 Skills especializados para agentes de IA
│   ├── rosorin-pro/SKILL.md
│   ├── gemini-live-js/SKILL.md
│   └── threejs-urdf-twin/SKILL.md
├── robot-bridge/                 # Puente HTTP + WebSocket (20 Hz) + Loop 40 Hz en Rust (Axum)
│   ├── src/main.rs               # Endpoints REST, servidor WS (:9000) y loop de 25 ms
│   ├── src/backend.rs            # Guardrails físicos, odometría, LiDAR (<0.28m) y drivers mock/serial/ros2
│   ├── src/gestures.rs           # Coreografías de brazo 6-DOF y chasis (incluye bailes Bumblebee)
│   ├── src/protocol.rs           # Tramas binarias STM32 (0xAA 0x55 @ 1 Mbps, CRC8)
│   └── scripts/ros2_worker.py    # Worker de ROS 2 Humble para tópicos y cámara/LiDAR (/scan)
└── web/                          # Aplicación Next.js 15 + React 19 + Three.js + @google/genai
    ├── .env.example              # Plantilla de variables de entorno (sin credenciales embebidas)
    ├── public/meshes/            # 16 mallas CAD .stl oficiales del Hiwonder ROSOrin Pro
    ├── public/songs/             # Catálogo JSON de 168 clips (95 ES / 73 EN) para Demo D Bumblebee
    └── src/
        ├── app/                  # Rutas /, /robot, /face, /props y /demos/{roaster,gatekeeper,bughunter,bumblebee}
        ├── components/           # Rosorin3DViewer, HardwareControlPanel, GeminiLiveConsole, TopNav
        └── lib/                  # gemini-live.ts, bumblebee-radio.ts, robot-client.ts, types.ts
```
