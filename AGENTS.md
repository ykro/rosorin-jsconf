# AGENTS.md

Guía corta para agentes de código (y personas) que trabajen en este repo. Es el código de la charla «De Web a Physical AI» y controla un robot real: los cambios en el bridge pueden mover motores.

## Mapa

| Carpeta | Qué hay | Lenguaje |
|---|---|---|
| `robot-bridge/` | Bridge HTTP y WebSocket (`rosorin-bridge`, puerto 9000): límites, freno por LiDAR, watchdog, E-stop, token. `scripts/ros2_worker.py` habla con el STM32 y ROS 2. | Rust, Python |
| `web/` | Next.js 15 (export estático): demos, gemelo 3D, cliente de Gemini Live y del bridge. | TypeScript |
| `docs/` | Documentación, `openapi.yaml`, diagramas (`assets/*.svg` con su fuente `.html`). | Markdown |
| `skills/` | Skills `rosorin-pro`, `gemini-live-js` y `threejs-urdf-twin`. | Markdown |
| `slides/`, `web/public/slides/` | Slides de la charla. | HTML |
| Raíz | `run.sh`, `iniciar-robot.sh`, `Makefile`, `firebase.json`. | Bash |

## Verificación

Antes de dar un cambio por terminado:

```bash
make test                                   # cargo test + tests del worker (sin rclpy) + npm test
make lint                                   # cargo clippy --all-targets -- -D warnings
cd web && npx tsc --noEmit && npm run lint && npm run check:css && npm run build
npx @redocly/cli@latest lint docs/openapi.yaml   # si tocaste la API
```

El CI (`.github/workflows/ci.yml`) corre lo mismo en cada push y PR.

## Reglas

- **No versiones MP3.** Los clips de `web/public/songs/clips/` tienen derechos de autor; `.gitignore` y `firebase.json` los excluyen. No los agregues a git ni los saques del `hosting.ignore`.
- **Nada secreto en `NEXT_PUBLIC_*`.** Esas variables se incrustan en el bundle público. La API key de Gemini va en `localStorage` y el token del bridge llega por `?token=` o el panel del robot.
- **No relajes la seguridad del bridge sin pedido explícito:** token fuera de loopback, `Host`/`Origin`, rate limit, E-stop enclavada, LiDAR que falla cerrado y límites de `protocol.rs`.
- **Slides fuera de alcance.** No modifiques `slides/` ni `web/public/slides/` salvo que el autor lo pida explícitamente.
- **La documentación debe coincidir con el código.** Si cambias rutas, códigos de error, variables, flags de `run.sh`, límites o telemetría, actualiza `README.md`, `docs/API.md`, `docs/openapi.yaml`, los diagramas afectados y los skills en el mismo cambio. Los fragmentos de código en docs y skills se copian literal del código.
- **Diagramas:** si editas un `docs/assets/*.svg`, aplica el mismo cambio al bloque `<svg>` de su `.html` y renderízalo para revisar que nada se corte.
- **Idioma:** docs y UI en español; nombres de código, identificadores y comentarios de código en inglés.
- No hagas commits, push ni deploy si no te lo piden.
