# AGENTS.md

Guía corta para agentes de código (y personas) que trabajen en este repo. Es el código de la charla «De Web a Physical AI» y controla un robot real: los cambios en el bridge pueden mover motores.

## Mapa

| Carpeta | Qué hay | Lenguaje |
|---|---|---|
| `robot-bridge/` | Bridge HTTP y WebSocket (`rosorin-bridge`, puerto 9000): límites, freno por LiDAR, watchdog, *heartbeat* del worker, E-stop, token. `scripts/ros2_worker.py` habla con el STM32 y ROS 2; `scripts/robot-common.sh` reúne las salvaguardas de los scripts de arranque. | Rust, Python, Bash |
| `web/` | Next.js 15 (export estático): demos, gemelo 3D, cliente de Gemini Live y del bridge. | TypeScript |
| `docs/` | Documentación, `openapi.yaml`, diagramas (`assets/*.svg` con su fuente `.html`). | Markdown |
| `skills/` | Skills `rosorin-pro`, `gemini-live-js` y `threejs-urdf-twin`. | Markdown |
| `slides/`, `web/public/slides/` | Slides de la charla. | HTML |
| Raíz | `run.sh`, `iniciar-robot.sh`, `traer-token.sh`, `ensayo.sh`, `demo.sh`, `Makefile`, `firebase.json`. | Bash |

## Verificación

Antes de dar un cambio por terminado:

```bash
make test                                   # cargo test + tests del worker (sin rclpy) + npm test
make lint                                   # cargo clippy --all-targets -- -D warnings
cd web && npx tsc --noEmit && npm run lint && npm run check:css && npm run check:gestures && npm run build
npx @redocly/cli@latest lint docs/openapi.yaml   # si tocaste la API (0 errores)
bash -n run.sh iniciar-robot.sh traer-token.sh ensayo.sh demo.sh robot-bridge/scripts/robot-common.sh   # si tocaste los scripts
```

El CI (`.github/workflows/ci.yml`) corre en cada push y PR todo lo anterior menos el lint de OpenAPI y la revisión de los scripts de Bash: build, tests y clippy de Rust (también con Rust 1.87), tests del worker y, en `web/`, `tsc`, `npm test`, `lint`, `check:css`, `check:gestures` y `build`.

## Robot físico

- Se entra por SSH como `ubuntu@<IP>` y el repo está en `~/Desktop/rosorin-jsconf`. El robot guarda sus propias notas en `~/robot_docs/ESTADO_SISTEMA.md`. Ahí corren también servicios `mission-*` y otra sesión de Claude (`claude remote-control`): no cambies la configuración del sistema sin pedirlo.
- ROS 2 usa `ROS_LOCALHOST_ONLY=1` (en `~/.bashrc` y `~/.zshrc`), y las variables de Hiwonder (`LIDAR_TYPE`, `DEPTH_CAMERA_TYPE`, `need_compile`) salen de `~/.zshrc`. Un `ssh` no interactivo no las carga: usa `zsh -c 'source ~/.zshrc; …'`.
- `start_app_node.service` es el bringup completo de Hiwonder (`bringup.launch.py`): controlador en `/dev/rrc`, LiDAR (`/scan_raw` → filtro → `/scan`), cámara Aurora, rosbridge, joystick e `init_pose` (mueve el brazo). `rosorin_pause_factory_services` lo detiene para liberar `/dev/rrc`, y `rosorin_start_sensors` vuelve a levantar solo `peripherals lidar.launch.py` y `depth_camera.launch.py`. Sin eso no hay `/scan` y el chasis queda bloqueado.
- El LiDAR de este robot está montado girado 180°: el ángulo 0 del driver mira hacia atrás y el filtro de Hiwonder recorta esa zona (`/scan` solo trae de 72° a 291°). Necesita `robot-bridge/lidar-mount.json` con `{"offset_deg": 180, "flip": false}` (fuera de git; el entorno gana). Sin eso, el sector «frente» queda ciego y el freno protege el lado equivocado. `make calibrar-sombra` lo detecta y ofrece escribirlo.
- El LiDAR solo cubre el frente y los lados: atrás lo tapan el chasis y los cables. El worker reporta ese sector en `lidar.uncovered` (`["back"]`) y el bridge no frena por él. El autor decidió que la reversa manual quede libre y que los gestos retrocedan lento (≤ 0.05 m/s) y poco, sin sensor. El mock sigue siendo de 360°.
- `ros2_worker.py` arma el nodo de cámara y `/scan` antes de su primera línea: importar rclpy, cv2 y numpy acapara el GIL cerca de un segundo y, hecho después, atrasa los `pong` más allá del *heartbeat* (`connected=false` al arrancar). El worker ignora SIGINT: el apagado lo maneja el bridge cerrando su stdin.
- Por defecto, `ensayo.sh --robot` y `demo.sh --robot` sirven la web desde el robot: un build estático (`web/out`, sin `NEXT_PUBLIC_GEMINI_API_KEY` ni modo ligero) con un servidor Python en `0.0.0.0:3000`. La laptop la abre en Chrome con `--unsafely-treat-insecure-origin-as-secure=http://<IP>:3000` y el perfil `~/.cache/rosorin-chrome`; sin esa bandera, `http://<IP>` no da micrófono. `--laptop-server` vuelve a la web en `localhost` de la laptop.
- En Bash, un proceso en segundo plano de un shell no interactivo nace ignorando SIGINT. Para apagarlo, mándale TERM.

## Reglas

- **No versiones MP3.** Los clips de `web/public/songs/clips/` tienen derechos de autor: `.gitignore` los deja fuera de git. No los agregues a git. El hosting sí los publica (decisión del autor, 2026-10-27): `firebase deploy` los sube desde `web/out`, que los copia de `web/public/songs/clips/` de la laptop.
- **Nada secreto en `NEXT_PUBLIC_*`.** Esas variables se incrustan en el bundle público. La API key de Gemini va en `GEMINI_API_KEY` (`web/.env` de donde corre el bridge): los lanzadores se la dan al bridge por entorno y la web la pide a `GET /config/gemini-key` y la tiene solo en memoria. Nunca va en una URL ni se guarda en el navegador. El token del bridge llega por `#token=` (o `?token=`) o el panel del robot. En scripts, pásale el token a `curl` por stdin (`rosorin_curl_with_token`), nunca en argumentos.
- **No relajes la seguridad del bridge sin pedido explícito:** token fuera de loopback, `Host`/`Origin` (IPs privadas solo con token o fuera de loopback), rate limit, E-stop enclavada (también al apagar), *heartbeat* del worker, LiDAR que falla cerrado, campo `blocked` y límites de `protocol.rs`.
- **Bridge y worker van juntos.** Un cambio en el protocolo entre `backend.rs` y `ros2_worker.py` (por ejemplo el *heartbeat*) obliga a actualizar los dos; documenta en el mismo cambio que en el robot hay que correr `make build-robot`.
- **Slides fuera de alcance.** No modifiques `slides/` ni `web/public/slides/` salvo que el autor lo pida explícitamente.
- **La documentación debe coincidir con el código.** Si cambias rutas, códigos de error, variables, flags de `run.sh`, `ensayo.sh` o `traer-token.sh`, límites o telemetría, actualiza `README.md`, `docs/` (incluido `docs/ENSAYO.md`), `docs/openapi.yaml`, los `.env.example`, los diagramas afectados y los skills en el mismo cambio. Los fragmentos de código en docs y skills se copian literal del código.
- **Diagramas:** si editas un `docs/assets/*.svg`, aplica el mismo cambio al bloque `<svg>` de su `.html` y renderízalo para revisar que nada se corte.
- **Idioma:** docs y UI en español; nombres de código, identificadores y comentarios de código en inglés.
- No hagas commits, push ni deploy si no te lo piden.
