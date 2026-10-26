# De Web a Physical AI: agentes físicos con Gemini Live y JavaScript

[![Sitio público](https://img.shields.io/badge/Sitio_p%C3%BAblico-jsconfmx26.web.app-EB6C36?style=for-the-badge)](https://jsconfmx26.web.app)
[![Slides](https://img.shields.io/badge/Slides-jsconfmx26.web.app%2Fslides-0E1117?style=for-the-badge)](https://jsconfmx26.web.app/slides)
[![Simulador 3D](https://img.shields.io/badge/Simulador_3D-jsconfmx26.web.app%2Fdemo-1A73E8?style=for-the-badge)](https://jsconfmx26.web.app/demo)
[![Modelo](https://img.shields.io/badge/Gemini_API-gemini--3.8--live-2E5AA8?style=for-the-badge)](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live)

![Arquitectura: navegador, Gemini Live en la nube, bridge en Rust y robot](./docs/assets/architecture.svg)

Repositorio de la charla **«De Web a Physical AI: Agentes Físicos con Gemini Live y JavaScript»** de **Adrián Catalán (`@adriancs.tech`)** en JSConf MX 2026.

Muestra cómo un equipo web puede construir un agente de Physical AI con las herramientas que ya conoce:

- **Gemini Live (`gemini-3.8-live`)** por WebSocket desde el navegador: audio PCM de 16 kHz de entrada y 24 kHz de salida, reanudación de sesión y herramientas *bloqueantes* que devuelven al modelo el resultado real de cada movimiento (`ok` o `error` con su código).
- **Gemelo digital en Three.js** armado con las 16 mallas `.stl` del fabricante. Se dibuja a la tasa de refresco del navegador y recibe la telemetría del robot a 20 Hz.
- **Bridge en Rust (`robot-bridge`, binario `rosorin-bridge`, puerto 9000)** con un loop de control de 40 Hz, límites por articulación, freno por LiDAR por eje, watchdog de 600 ms, paro de emergencia enclavado y token obligatorio fuera de `localhost`.
- **Hiwonder ROSOrin Pro** con **NVIDIA Jetson Orin Nano**, **ROS 2 Humble** y un coprocesador **STM32** por UART a 1 Mbps.

---

## Sitio público, slides y simulador

| Qué | URL | Nota |
|---|---|---|
| Inicio | [jsconfmx26.web.app](https://jsconfmx26.web.app) | Enlaces a slides, simulador y código. |
| Slides | [jsconfmx26.web.app/slides](https://jsconfmx26.web.app/slides) | Se sirven desde `web/public/slides/`. |
| Simulador 3D y demos | [jsconfmx26.web.app/demo](https://jsconfmx26.web.app/demo) | Corre en el navegador; las demos de voz piden tu API key de Gemini. |

El sitio público **no contacta ningún robot** hasta que alguien pulsa «Conectar» en el panel del robot (o abre la página con `?bridge=` o `?token=`). Además, su CSP solo permite `localhost:9000` y `127.0.0.1:9000`, y una página `https://` no puede hablar con una IP `http://` de la red local. Por eso **la demo con el robot físico se usa desde `http://localhost:3000`**, con el repositorio clonado.

---

## Requisitos

- **Node.js 22** (el repo trae [`.nvmrc`](./.nvmrc); `web/package.json` exige `>= 22.6`) y `npm`.
- **Rust con `cargo >= 1.87`** (`rust-version` de [`robot-bridge/Cargo.toml`](./robot-bridge/Cargo.toml)). Si falta, `./run.sh` ofrece instalarlo con rustup y pide confirmación (`--yes` para no preguntar).
- **Una API key de Gemini** de [Google AI Studio](https://aistudio.google.com/apikey). Se pega en el navegador (botón «Ingresar API Key» de la consola de cada demo o panel «Gemini Live API Key» de `/demo`) y se guarda en `localStorage` bajo `rosorin_gemini_api_key`. Para desarrollo local también puedes ponerla en `web/.env.local` como `NEXT_PUBLIC_GEMINI_API_KEY`, pero **nunca hagas `npm run build` ni despliegues con esa variable definida**: el sitio es un export estático y la clave quedaría dentro del bundle público.
- Para el robot: Python 3 con ROS 2 Humble en el Jetson (lo usa `robot-bridge/scripts/ros2_worker.py`).

---

## Arranque rápido

### Opción 1: simulador en tu laptop (sin robot)

```bash
git clone https://github.com/ykro/rosorin-jsconf.git
cd rosorin-jsconf
./run.sh --mock
```

- Compila y levanta el bridge con `--backend mock` en `http://127.0.0.1:9000` (solo loopback).
- Levanta la web en `http://localhost:3000` (también solo en `127.0.0.1`; `--web-lan` la expone en la red).
- `run.sh` imprime la URL que debes abrir. En modo mock no hay token, así que es `http://localhost:3000/`.

### Opción 2: tu laptop conectada al robot por Wi-Fi

1. En el Jetson del robot (por SSH), dentro del repo:
   ```bash
   make robot          # equivale a ./run.sh --bridge-only
   ```
   El bridge escucha en `0.0.0.0:9000` y **exige token**. Si no hay `BRIDGE_TOKEN` en el entorno, `run.sh` genera uno y lo guarda en `.bridge-token` con permisos `600`.
2. En tu laptop, copia el token y arranca la web apuntando al robot:
   ```bash
   scp <usuario>@<IP_DEL_ROBOT>:<ruta-del-repo>/.bridge-token .bridge-token && chmod 600 .bridge-token
   ./run.sh --robot-ip <IP_DEL_ROBOT>
   ```
3. Abre la URL que imprime `run.sh`: `http://localhost:3000/?token=<token>&bridge=http://<IP_DEL_ROBOT>:9000`. La web guarda el token, lo quita de la barra de direcciones y desde ahí lo manda en cada petición.

Sin el token, `./run.sh --robot-ip` se detiene y te explica cómo traerlo. El detalle de cada modo, las banderas y la solución de problemas están en [`docs/ONBOARDING.md`](./docs/ONBOARDING.md).

### Otros comandos

| Comando | Qué hace |
|---|---|
| `make up` / `make start` | `./run.sh` con autodetección de backend (ros2, serial o mock). |
| `make robot` | `./run.sh --bridge-only`: solo el bridge, para el robot. |
| `make bridge` | El bridge en `127.0.0.1:9000` con `ROBOT_BACKEND` (mock por defecto). |
| `make web` | Solo la web (`npm run dev`). |
| `make reset` | `POST /stop`: paro de emergencia (motores a 0, brazo congelado, E-stop enclavada). |
| `make release` | `POST /estop/release`: libera la E-stop. |
| `make test` | Tests de Rust, del worker de Python (sin rclpy) y de la web. |
| `make lint` | `cargo clippy --all-targets -- -D warnings`. |
| `make build-robot` | Binario de release del bridge. |
| `./iniciar-robot.sh` | En el robot: levanta bridge y web si no están corriendo y abre `/face?token=…` en modo kiosco en la pantalla de 7". |

`make reset` y `make release` hablan con `localhost`, así que se corren en la máquina del bridge. Leen el token de `BRIDGE_TOKEN` o de `.bridge-token`.

---

## Seguridad y operación

El robot se mueve de verdad, así que el bridge aplica estas reglas (detalle en [`docs/API.md`](./docs/API.md)):

- **Token.** Por defecto el bridge escucha en `127.0.0.1`. Si escucha en otra dirección y no hay `BRIDGE_TOKEN`, sale con código `2` (salvo con `--insecure-no-token`, que no recomendamos). El token va en `x-bridge-token` o `Authorization: Bearer`; `?token=` solo se acepta en `/ws`. `GET /health` y los preflight `OPTIONS` no lo piden.
- **El token en la web.** Llega por `?token=` (lo imprime `run.sh`), se puede pegar en el panel que abre la píldora del robot en la barra superior y vive en `localStorage` como `ROSORIN_BRIDGE_TOKEN` (`?token=reset` lo borra). **Nunca va en una variable `NEXT_PUBLIC_*`**, porque esas terminan en el bundle público.
- **Origen y host.** Se aceptan orígenes `localhost`, IPs privadas o de loopback, `jsconfmx26.web.app`, `jsconfmx26.firebaseapp.com` y los que agregues en `BRIDGE_ALLOWED_ORIGINS`. El header `Host` debe ser una IP, `localhost` o un nombre de `BRIDGE_ALLOWED_HOSTS` (por ejemplo `rosorin.local`).
- **Límite de peticiones.** 30 POST por segundo con ráfaga de 60, global. `/stop` y `/estop/release` no cuentan.
- **Paro de emergencia enclavado.** `POST /stop` (botón «Paro de emergencia» del panel, botón **PARO** en `/face` o `make reset`) detiene motores, congela el brazo donde está y bloquea todo movimiento con `423 estop_latched` hasta `POST /estop/release` (botón «Liberar» o `make release`).
- **LiDAR que falla cerrado.** Con `ros2`, si no llega un scan en más de 300 ms o el worker muere, el chasis queda bloqueado; también al arrancar, hasta el primer scan. Con `serial` no hay LiDAR: la telemetría dice `lidar_source: "none"` y la velocidad lineal se limita a 0.15 m/s.
- **Freno por eje.** Si un sector está a menos de 0.28 m se anula la velocidad hacia ese lado (`vx` con frente y atrás, `vy` con izquierda y derecha) y `|wz|` se limita a 0.3 rad/s. `obstacle_alert` se enciende con cualquier sector por debajo de 0.35 m.
- **Sombra del brazo.** El worker ignora ecos a menos de `ARM_SHADOW_MAX_M` (0.12 m) dentro de ±`ARM_SHADOW_HALF_ANGLE_DEG` (35°) al frente, porque son el propio brazo. **Calíbralo en tu robot** con `ros2 topic echo /scan`: si el brazo aparece más lejos, el avance quedará bloqueado siempre.
- **`run.sh` en el robot** detiene `button_scan.service` y `start_app_node.service` (ocupan `/dev/rrc`), no toca `wifi.service` y aborta si existe `~/.openclaw/workspace/ESTOP_LOCK`, el candado de paro de otra app, sin borrarlo.
- **Backend explícito.** `--serial`, `--ros2` o `ROBOT_BACKEND` no caen a mock si fallan: el bridge sale con código `1`. Solo la autodetección de `run.sh` pasa `--allow-mock-fallback`. Si el loop de control muere, el bridge detiene los motores y sale con código `70`.
- **Lo que queda a la vista.** `run.sh` imprime el token en la terminal a propósito, y la URL del kiosco que abre `iniciar-robot.sh` lleva el token en los argumentos del navegador (visible con `ps` en el robot).

Las variables del bridge están documentadas en [`robot-bridge/.env.example`](./robot-bridge/.env.example) y las de la web en [`web/.env.example`](./web/.env.example).

---

## Las 4 demos

| Demo | Ruta | Herramienta de Gemini | Qué pasa |
|---|---|---|---|
| **A · Repo Roaster** | `/demos/roaster` | `express_verdict` | Analiza un repo de GitHub. La app ejecuta el gesto (`facepalm`, `trash_toss`, `chef_kiss`, `suspicious_inspect`, `victory_spin`…) y el modelo solo habla. Si GitHub no responde, los datos aparecen como «no disponible». |
| **B · Gatekeeper CI/CD** | `/demos/gatekeeper` | `release_deploy_key` | El robot sostiene una llave impresa con la pinza (servo 10, cerrada en 680). La app decide con los datos del PR y el robot gira a la bandeja verde (`joint1 = 700`) o roja (`joint1 = 280`) y abre la pinza (220). |
| **C · Bug Hunter** | `/demos/bughunter` | `point_at_service_totem` | Ante un incidente simulado, el chasis se desliza de lado unos 19 cm y el brazo apunta al tótem del servicio culpable. |
| **D · Bumblebee Radio** | `/demos/bumblebee` | `play_radio_sequence` | El robot responde solo con fragmentos de canciones del catálogo (168 clips: 95 en español, 73 en inglés) y baila con 6 coreografías `bumblebee_*`. |

**Sobre los MP3 de Bumblebee:** los clips no están en git (`.gitignore`) ni se despliegan (`firebase.json` los excluye con `hosting.ignore: songs/clips/**`). En el sitio público Bumblebee reproduce un barrido de radio, muestra el aviso «Clip no disponible» y mantiene la letra en el dial. En local (`localhost:3000`) usa los clips si los colocas en `web/public/songs/clips/` (ver su [README](./web/public/songs/clips/README.md)).

Paso a paso de cada demo en [`docs/DEMOS.md`](./docs/DEMOS.md).

### Rutas de la web

| Ruta | Para qué |
|---|---|
| `/` | Inicio: enlaces a slides, simulador y código. |
| `/simulator` | Alias de `/`. |
| `/demo` | Simulador 3D con panel de servos, chasis, LiDAR y accesos a las 4 demos (con `NEXT_PUBLIC_LITE_MODE=1` muestra la consola ligera). |
| `/robot` | Consola ligera sin WebGL, pensada para la pantalla del robot. |
| `/demos/roaster`, `/demos/gatekeeper`, `/demos/bughunter`, `/demos/bumblebee` | Las 4 demos. |
| `/face` | Rostro del robot para la pantalla táctil de 7": ojos, estado de voz, letras de Bumblebee, banners de seguridad y botón **PARO**. |
| `/presenter` | Pantalla del presentador: telemetría en vivo y disparo de los gestos de los repos de ensayo. |
| `/props` | Descarga de los props imprimibles a escala 1:1. |
| `/slides` | Slides de la charla (archivos estáticos de `web/public/slides/`). |

---

## Skills para agentes de código

La carpeta [`skills/`](./skills) trae 3 skills que documentan el hardware, la sesión de Gemini Live y el gemelo 3D tal como están en el código:

| Skill | Qué cubre |
|---|---|
| [`rosorin-pro`](./skills/rosorin-pro/SKILL.md) | Servos (IDs 1 a 5 y pinza 10, nunca 6), límites por articulación, protocolo STM32 (`0xAA 0x55`, CRC8, 1 Mbps), tópicos de ROS 2, freno por eje, E-stop y token. |
| [`gemini-live-js`](./skills/gemini-live-js/SKILL.md) | Sesión Live con reanudación y compresión, estados de conexión, audio 16/24 kHz, barge-in por generación, herramientas bloqueantes con resultado real y datos no confiables. |
| [`threejs-urdf-twin`](./skills/threejs-urdf-twin/SKILL.md) | Mallas STL del fabricante, cadena URDF `J1..J5` y pinza paralela, suavizado independiente de los FPS y limpieza de recursos. |

Las reglas para agentes que trabajen en este repo están en [`AGENTS.md`](./AGENTS.md).

---

## Documentación

- [`docs/ONBOARDING.md`](./docs/ONBOARDING.md): modos de ejecución, token, banderas de `run.sh` y problemas comunes.
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md): capas, tiempos, por qué Rust y la pantalla `/face`.
- [`docs/RUST_FOR_WEB_DEVS.md`](./docs/RUST_FOR_WEB_DEVS.md): cómo funciona `robot-bridge` explicado desde Node.js.
- [`docs/API.md`](./docs/API.md) y [`docs/openapi.yaml`](./docs/openapi.yaml): contrato HTTP y WebSocket del bridge, errores y herramientas de Gemini.
- [`docs/DEMOS.md`](./docs/DEMOS.md): guion de las 4 demos.
- [`docs/generate_props_pdf.py`](./docs/generate_props_pdf.py): genera `docs/rosorin-stage-props-print.pdf` (y su copia en `web/public/props/`) con Chrome headless.

---

## Estructura del repositorio

```text
rosorin-jsconf/
├── run.sh                    # Lanzador: --mock | --robot-ip <IP> | --serial | --ros2 | --bridge-only (--help)
├── iniciar-robot.sh          # Arranque en el robot: bridge + web + /face en kiosco
├── Makefile                  # up, robot, bridge, web, reset, release, test, lint, build-robot
├── .nvmrc                    # Node 22
├── firebase.json             # Hosting de jsconfmx26.web.app (CSP, sin songs/clips/)
├── LICENSE                   # MIT
├── NOTICE                    # Atribución de las mallas de Hiwonder y nota sobre los clips
├── AGENTS.md · CONTRIBUTING.md
├── .github/workflows/ci.yml  # Rust, Python y web en cada push y PR
├── slides/                   # Fuente de la presentación
├── docs/                     # Documentación, OpenAPI, diagramas (assets/*.svg y su fuente .html), PDF de props
├── skills/                   # rosorin-pro, gemini-live-js, threejs-urdf-twin
├── robot-bridge/             # Bridge en Rust (axum + tokio)
│   ├── .env.example          # Todas las variables y flags del bridge
│   ├── src/main.rs           # Rutas, token, origen/host, rate limit, WebSocket y loop de 40 Hz
│   ├── src/backend.rs        # Backends mock/serial/ros2, freno por eje, watchdog, E-stop
│   ├── src/gestures.rs       # Coreografías (incluye los bailes de Bumblebee)
│   ├── src/protocol.rs       # Tramas STM32 (0xAA 0x55, CRC8), límites de servos y velocidad
│   └── scripts/              # ros2_worker.py y sus tests sin rclpy
└── web/                      # Next.js 15 + React 19 + Three.js + @google/genai (export estático)
    ├── .env.example
    ├── public/meshes/        # 16 mallas .stl del ROSOrin Pro
    ├── public/songs/         # catalog.json (168 clips) y clips/ (MP3 locales, fuera de git)
    ├── public/slides/        # Slides que se despliegan
    ├── scripts/              # check-css-classes.mjs
    └── src/
        ├── app/              # /, /demo, /simulator, /robot, /face, /presenter, /props, /demos/*
        ├── components/       # Rosorin3DViewer, HardwareControlPanel, GeminiLiveConsole, TopNav, BridgeControls
        └── lib/              # gemini-live, live-connection, bumblebee-radio, robot-client, bridge-config, tool-args…
```

## Licencia

El código es MIT ([`LICENSE`](./LICENSE)). Las mallas 3D son de Hiwonder y se incluyen con atribución; ver [`NOTICE`](./NOTICE). Para contribuir, lee [`CONTRIBUTING.md`](./CONTRIBUTING.md).
