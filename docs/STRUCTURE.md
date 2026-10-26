# Estructura del repositorio

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
    ├── public/slides/        # Slides que se despliegan (copia de slides/)
    ├── scripts/              # check-css-classes.mjs, gen-gestures.mjs
    └── src/
        ├── app/              # /, /demo, /simulator, /robot, /face, /presenter, /props, /demos/*
        ├── components/       # Rosorin3DViewer, HardwareControlPanel, GeminiLiveConsole, TopNav, BridgeControls
        └── lib/              # gemini-live, live-connection, bumblebee-radio, robot-client, bridge-config,
                              # tool-args, gesture-choreographies.generated…
```
