# Seguridad y operación

El robot se mueve de verdad, así que `robot-bridge` aplica estas reglas. El contrato exacto de cada respuesta (códigos, cuerpos JSON y orden de los filtros) está en [`API.md`](./API.md).

## Token

- Por defecto el bridge escucha en `127.0.0.1`. Si escucha en otra dirección y no hay `BRIDGE_TOKEN`, sale con código `2` (salvo con `--insecure-no-token`, que no recomendamos).
- El token va en `x-bridge-token` o `Authorization: Bearer`. `?token=` solo se acepta en `/ws`. `GET /health` y los preflight `OPTIONS` no lo piden.
- En el robot, `run.sh` lo genera si falta y lo guarda en `.bridge-token` con permisos `600`. Cómo llevarlo a tu laptop está en [`ONBOARDING.md`](./ONBOARDING.md#paso-3-traer-el-token-a-tu-laptop).

### El token en la web

- Llega por `?token=` (lo imprime `run.sh`), se puede pegar en el panel que abre la píldora del robot en la barra superior y vive en `localStorage` como `ROSORIN_BRIDGE_TOKEN`. `?token=reset` lo borra.
- **Nunca va en una variable `NEXT_PUBLIC_*`**, porque esas terminan en el bundle público.

## Origen y host

- Se aceptan orígenes `localhost`, IPs privadas o de loopback, `jsconfmx26.web.app`, `jsconfmx26.firebaseapp.com` y los que agregues en `BRIDGE_ALLOWED_ORIGINS`.
- El header `Host` debe ser una IP, `localhost` o un nombre de `BRIDGE_ALLOWED_HOSTS` (por ejemplo `rosorin.local`).

## Límite de peticiones

30 POST por segundo con ráfaga de 60, global. `/stop` y `/estop/release` no cuentan.

## Paro de emergencia enclavado

`POST /stop` (botón «Paro de emergencia» del panel, botón **PARO** en `/face` o `make reset`) detiene motores, congela el brazo donde está y bloquea todo movimiento con `423 estop_latched` hasta `POST /estop/release` (botón «Liberar» o `make release`).

## LiDAR que falla cerrado

- Con `ros2`, si no llega un scan en más de 300 ms o el worker muere, el chasis queda bloqueado; también al arrancar, hasta el primer scan.
- Con `serial` no hay LiDAR: la telemetría dice `lidar_source: "none"` y la velocidad lineal se limita a 0.15 m/s.

## Freno por eje

Si un sector está a menos de 0.28 m se anula la velocidad hacia ese lado (`vx` con frente y atrás, `vy` con izquierda y derecha) y `|wz|` se limita a 0.3 rad/s. `obstacle_alert` se enciende con cualquier sector por debajo de 0.35 m.

## Sombra del brazo

El worker ignora ecos a menos de `ARM_SHADOW_MAX_M` (0.12 m) dentro de ±`ARM_SHADOW_HALF_ANGLE_DEG` (35°) al frente, porque son el propio brazo. **Calíbralo en tu robot** con `ros2 topic echo /scan`: si el brazo aparece más lejos, el avance quedará bloqueado siempre.

## `run.sh` en el robot

Detiene `button_scan.service` y `start_app_node.service` (ocupan `/dev/rrc`), no toca `wifi.service` y aborta si existe `~/.openclaw/workspace/ESTOP_LOCK`, el candado de paro de otra app, sin borrarlo.

## Backend explícito

`--serial`, `--ros2` o `ROBOT_BACKEND` no caen a mock si fallan: el bridge sale con código `1`. Solo la autodetección de `run.sh` pasa `--allow-mock-fallback`. Si el loop de control muere, el bridge detiene los motores y sale con código `70`.

## Lo que queda a la vista

- `run.sh` imprime el token en la terminal a propósito. No proyectes esa terminal en el escenario.
- La URL del kiosco que abre `iniciar-robot.sh` lleva el token en los argumentos del navegador (visible con `ps` en el robot).
- El bridge habla HTTP sin TLS: usa una red Wi-Fi propia del robot (WPA2), no la del evento.

## Variables

Las variables del bridge están documentadas en [`robot-bridge/.env.example`](../robot-bridge/.env.example) y las de la web en [`web/.env.example`](../web/.env.example).
