# Estructura del repositorio

```text
rosorin-jsconf/
├── run.sh                    # Lanzador: --mock | --robot-ip <IP> | --serial | --ros2 | --bridge-only (--help)
├── iniciar-robot.sh          # Arranque en el robot: bridge + web + /face#token= en kiosco
├── traer-token.sh            # En la laptop: trae .bridge-token del robot por SSH (permisos 600)
├── ensayo.sh                 # En la laptop: guía del ensayo con el robot (bitácora ensayo-<fecha>.log, fuera de git)
├── Makefile                  # up, robot, bridge, web, reset, release, test, lint, build-robot, calibrar-sombra
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
│   ├── .env.example          # Variables y flags del bridge y del worker
│   ├── arm-shadow.json       # Calibración de la sombra del brazo de cada robot (make calibrar-sombra; fuera de git)
│   ├── src/main.rs           # Rutas, token, origen/host, rate limit, WebSocket, loop de 40 Hz y apagado
│   ├── src/backend.rs        # Backends mock/serial/ros2, freno por eje, watchdog, E-stop, heartbeat y campo blocked
│   ├── src/gestures.rs       # Coreografías (incluye los bailes de Bumblebee)
│   ├── src/protocol.rs       # Tramas STM32 (0xAA 0x55, CRC8), límites de servos y velocidad
│   └── scripts/
│       ├── ros2_worker.py        # Worker de ROS 2: SDK del STM32 o tópicos, /scan por sectores, sombra del brazo, pong
│       ├── test_ros2_worker.py   # Tests del worker sin rclpy
│       ├── calibrar_sombra.py    # make calibrar-sombra: mide dónde ve el LiDAR al brazo y escribe arm-shadow.json
│       ├── test_calibrar_sombra.py # Tests de la calibración sin rclpy
│       └── robot-common.sh       # Funciones de run.sh, iniciar-robot.sh y ensayo.sh: token, ESTOP_LOCK,
│                                 # servicios de fábrica y curl con el token por stdin
└── web/                      # Next.js 15 + React 19 + Three.js + @google/genai (export estático)
    ├── .env.example
    ├── public/meshes/        # 16 mallas .stl del ROSOrin Pro
    ├── public/songs/         # catalog.json (168 clips) y clips/ (MP3 locales, fuera de git)
    ├── public/slides/        # Slides que se despliegan (copia de slides/)
    ├── scripts/              # check-css-classes.mjs, gen-gestures.mjs
    └── src/
        ├── app/              # /, /demo, /simulator, /robot, /face, /presenter, /props, /demos/*,
        │                     # error.tsx (error de ruta con paro de emergencia)
        ├── components/       # Rosorin3DViewer, ViewerErrorBoundary, HardwareControlPanel, GeminiLiveConsole,
        │                     # TopNav (PARO y tecla Escape), BridgeControls
        └── lib/              # gemini-live, live-connection, live-turn-gate, tool-policy, tool-args,
                              # bumblebee-radio, robot-client, bridge-config, gesture-choreographies.generated…
```
