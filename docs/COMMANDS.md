# Comandos del repo

| Comando | Dónde | Qué hace |
|---|---|---|
| `./run.sh --mock` | Laptop | Bridge simulado en `127.0.0.1:9000` y web en `http://localhost:3000`. Las demás banderas están en [`ONBOARDING.md`](./ONBOARDING.md#5-banderas-de-runsh). |
| `./run.sh --robot-ip <IP>` | Laptop | Solo la web, contra el bridge del robot. Necesita el token; imprime `http://localhost:3000/?bridge=http://<IP>:9000#token=<t>`. Al cerrarlo manda `/stop` al robot. |
| `./traer-token.sh [<usuario>@]<IP> [ruta]` | Laptop | Lee `.bridge-token` del robot por SSH y lo guarda en el `.bridge-token` local con permisos `600`. Usuario por defecto: `ROBOT_USER` o el local. Ruta por defecto: `~/Desktop/rosorin-jsconf` (o `ROBOT_REPO`). |
| `./ensayo.sh --robot-ip <IP> --ssh <usuario>@<IP>` | Laptop | Guía del ensayo con el robot: revisa versión, token, worker, LiDAR, sombra del brazo, ruedas, paros y demos, y deja `ensayo-<fecha>.log`. Opciones y flujo en [`ENSAYO.md`](./ENSAYO.md). |
| `make up` / `make start` | Cualquiera | `./run.sh` con autodetección de backend (ros2, serial o mock). |
| `make robot` | Robot | `./run.sh --bridge-only`: solo el bridge, en `0.0.0.0:9000` con token. |
| `make build-robot` | Robot | Binario de release del bridge (`cargo build --release`). Córrelo después de cada `git pull`: el bridge y `ros2_worker.py` se actualizan juntos, e `iniciar-robot.sh` usa este binario. |
| `make calibrar-sombra` | Robot | Con el bridge corriendo (`make robot`) y ROS 2: pide confirmar 50 cm despejados, mueve **solo el brazo** por cada pose de los gestos, lee el `/scan` crudo y guarda la banda donde el LiDAR ve el brazo en `robot-bridge/arm-shadow.json`. Después reinicia `make robot`. Opciones del script (`python3 robot-bridge/scripts/calibrar_sombra.py`): `--yes`, `--bridge <url>`, `--hold <s>`. Ver [`SECURITY.md`](./SECURITY.md#sombra-del-brazo). |
| `make bridge` | Cualquiera | El bridge en `127.0.0.1:9000` con `ROBOT_BACKEND` (mock por defecto). |
| `make web` | Cualquiera | Solo la web (`npm run dev`). |
| `make reset` | Máquina del bridge | `POST /stop`: paro de emergencia (motores a 0, brazo congelado, E-stop enclavada). |
| `make release` | Máquina del bridge | `POST /estop/release`: libera la E-stop. |
| `make test` | Cualquiera | Tests de Rust (`cargo test`), del worker de Python (sin rclpy) y de la web (`npm test`). |
| `make lint` | Cualquiera | `cargo clippy --all-targets -- -D warnings`. |
| `./iniciar-robot.sh` | Robot | Aborta si existe el candado `ESTOP_LOCK`; si no, levanta bridge y web si no están corriendo y abre `/face#token=…` en modo kiosco en la pantalla de 7". |

`make reset` y `make release` hablan con `localhost`, así que se corren en la máquina del bridge. Leen el token de `BRIDGE_TOKEN` o de `.bridge-token` y se lo pasan a `curl` por stdin (`-H @-`, requiere `curl >= 7.55`), así que no aparece en `ps` ni en `make -n`.

## Scripts de la web

Dentro de `web/`:

| Script | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo en `localhost:3000`. |
| `npm run build` | Export estático en `web/out/` (lo que se despliega). |
| `npm test` | Tests de `src/lib/__tests__/` con `node --test` (usa `--experimental-test-module-mocks`; ya viene en el script). |
| `npm run lint` | ESLint sobre `src` y `scripts`. |
| `npm run check:css` | Verifica que cada clase usada en los `.tsx` exista en `globals.css` y que su nombre coincida con su color. |
| `npm run gen:gestures` | Regenera `src/lib/gesture-choreographies.generated.ts` desde `robot-bridge/src/gestures.rs`. Córrelo después de cambiar una coreografía en Rust. |
| `npm run check:gestures` | Falla si el archivo generado no coincide con `gestures.rs` (lo corre el CI). |

## Props imprimibles

[`docs/generate_props_pdf.py`](./generate_props_pdf.py) genera `docs/rosorin-stage-props-print.pdf` (y su copia en `web/public/props/`) con Chrome headless.
