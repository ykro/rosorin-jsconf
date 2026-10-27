# La web: sitio público, rutas y simulador

## Sitio público

| Qué | URL | Nota |
|---|---|---|
| Hub | [jsconfmx26.web.app](https://jsconfmx26.web.app) | Enlaces a slides, simulador y código. |
| Slides | [jsconfmx26.web.app/slides](https://jsconfmx26.web.app/slides) | Se sirven desde `web/public/slides/`. En local, abre `/slides/index.html`. |
| Simulador 3D | [jsconfmx26.web.app/demo](https://jsconfmx26.web.app/demo) | Corre en el navegador; las demos de voz piden tu API key de Gemini. |

El sitio público **no contacta ningún robot** hasta que alguien pulsa «Conectar» en el panel del robot (o abre la página con `?bridge=` o con un token en `#token=` o `?token=`). Además, su CSP solo permite `localhost:9000` y `127.0.0.1:9000`, y una página `https://` no puede hablar con una IP `http://` de la red local. Por eso **la demo con el robot físico se usa desde `http://localhost:3000`**, con el repositorio clonado.

## Rutas

| Ruta | Para qué |
|---|---|
| `/` | Hub: enlaces a slides, simulador y código. |
| `/simulator` | Alias de `/`. |
| `/demo` | Simulador 3D con panel de servos, chasis, LiDAR y gestos (con `NEXT_PUBLIC_LITE_MODE=1` muestra la consola ligera). Las demos se abren desde la barra superior. |
| `/robot` | Consola ligera sin WebGL, pensada para la pantalla del robot. |
| `/demos/roaster`, `/demos/gatekeeper`, `/demos/bughunter`, `/demos/bumblebee` | Las 4 demos (ver [`DEMOS.md`](./DEMOS.md)). |
| `/face` | Rostro del robot para la pantalla táctil de 7": ojos, estado de voz, letras de Bumblebee, banners de seguridad y botón **STOP** (visible siempre que el bridge esté habilitado, aunque el WebSocket esté caído). `iniciar-robot.sh` la abre como `/face#token=<t>`. |
| `/presenter` | Pantalla del presentador: telemetría en vivo y disparo de los gestos de los repos de ensayo. |
| `/props` | Descarga de los props imprimibles a escala 1:1. |
| `/slides` | Slides de la charla (archivos estáticos de `web/public/slides/`). |

## Paro de emergencia y token

- **STOP fijo.** Las páginas con barra superior (`/`, `/demo`, `/robot` y las 4 demos) muestran un botón **STOP** rojo cuando el bridge está habilitado; en `localhost` lo está por defecto. La tecla **Escape** hace lo mismo, salvo mientras escribes en un campo de texto; si el panel del robot está abierto, Escape primero lo cierra. El STOP manda `POST /stop` directo, así que funciona aunque el WebSocket de telemetría esté caído, y también detiene el gemelo 3D.
- **Token.** La web lo toma de `#token=<t>` (lo que imprime `run.sh`) o de `?token=<t>`, lo guarda en `localStorage` y lo quita de la barra. El panel de la píldora del robot muestra el host del bridge; si cambias a otro host, el token guardado se borra. Los detalles están en [`SECURITY.md`](./SECURITY.md#el-token-en-la-web).
- **Control del robot sin respuesta.** Si la telemetría trae `connected: false` (worker atascado o caído), aparece el banner «El control del robot no responde: chasis bloqueado». Un STOP en ese estado igual enclava la E-stop en el bridge y la web lo marca como enviado, con un aviso de apagar el robot si sigue moviéndose.
- **Respuestas bloqueadas.** Si el bridge acepta un movimiento pero responde `blocked` (`braked`, `lidar_stale` o `worker_dead`), la web lo muestra como error y nunca como éxito.

## Sin WebGL

Si el navegador no tiene WebGL, el simulador muestra «Sin WebGL: el simulador 3D no está disponible» y el resto de la página sigue funcionando: consola Live, botones del robot y STOP. Si el visor falla por otra causa, su error boundary muestra «El simulador 3D falló» con «Reintentar». Un error que tumbe la ruta completa cae en `app/error.tsx`, que conserva la barra superior y ofrece «Reintentar» y, si el bridge está habilitado, **STOP**, que llama directo al bridge.

## Gestos del robot

El panel «Gestos del Robot» de `/demo` y `/robot` muestra los gestos con su nombre en inglés: **Wave Hello**, **Facepalm**, **Trash Toss**, **Chef Kiss**, **Victory Spin** y **Suspicious Inspect**. Los de Bumblebee aparecen en su demo.

Cada botón dispara la coreografía completa de [`robot-bridge/src/gestures.rs`](../robot-bridge/src/gestures.rs): varios pasos de servos, LED y movimiento del chasis. Sin bridge, el gemelo 3D reproduce los mismos pasos desde [`web/src/lib/gesture-choreographies.generated.ts`](../web/src/lib/gesture-choreographies.generated.ts), que `npm run gen:gestures` genera a partir de `gestures.rs`, e integra la velocidad de cada paso igual que el bridge. `npm run check:gestures` (en el CI) falla si los dos se desincronizan.

## Variables

Las variables de la web están en [`web/.env.example`](../web/.env.example). La API key de Gemini se pega en el navegador y vive en `localStorage`; ver [`ONBOARDING.md`](./ONBOARDING.md#1-requisitos).
