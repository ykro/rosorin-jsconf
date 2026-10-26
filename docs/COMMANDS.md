# Comandos del repo

| Comando | Qué hace |
|---|---|
| `./run.sh --mock` | Bridge simulado en `127.0.0.1:9000` y web en `http://localhost:3000`. Las demás banderas están en [`ONBOARDING.md`](./ONBOARDING.md#5-banderas-de-runsh). |
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

## Scripts de la web

Dentro de `web/`:

| Script | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo en `localhost:3000`. |
| `npm run build` | Export estático en `web/out/` (lo que se despliega). |
| `npm test` | Tests de `src/lib/__tests__/`. |
| `npm run lint` | ESLint con la configuración de Next. |
| `npm run check:css` | Verifica que cada clase usada en el JSX exista en `globals.css` y que su nombre coincida con su color. |
| `npm run gen:gestures` | Regenera `src/lib/gesture-choreographies.generated.ts` desde `robot-bridge/src/gestures.rs`. Córrelo después de cambiar una coreografía en Rust. |
| `npm run check:gestures` | Falla si el archivo generado no coincide con `gestures.rs` (lo corre el CI). |

## Props imprimibles

[`docs/generate_props_pdf.py`](./generate_props_pdf.py) genera `docs/rosorin-stage-props-print.pdf` (y su copia en `web/public/props/`) con Chrome headless.
