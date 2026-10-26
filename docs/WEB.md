# La web: sitio público, rutas y simulador

## Sitio público

| Qué | URL | Nota |
|---|---|---|
| Hub | [jsconfmx26.web.app](https://jsconfmx26.web.app) | Enlaces a slides, simulador y código. |
| Slides | [jsconfmx26.web.app/slides](https://jsconfmx26.web.app/slides) | Se sirven desde `web/public/slides/`. En local, abre `/slides/index.html`. |
| Simulador 3D | [jsconfmx26.web.app/demo](https://jsconfmx26.web.app/demo) | Corre en el navegador; las demos de voz piden tu API key de Gemini. |

El sitio público **no contacta ningún robot** hasta que alguien pulsa «Conectar» en el panel del robot (o abre la página con `?bridge=` o `?token=`). Además, su CSP solo permite `localhost:9000` y `127.0.0.1:9000`, y una página `https://` no puede hablar con una IP `http://` de la red local. Por eso **la demo con el robot físico se usa desde `http://localhost:3000`**, con el repositorio clonado.

## Rutas

| Ruta | Para qué |
|---|---|
| `/` | Hub: enlaces a slides, simulador y código. |
| `/simulator` | Alias de `/`. |
| `/demo` | Simulador 3D con panel de servos, chasis, LiDAR y gestos (con `NEXT_PUBLIC_LITE_MODE=1` muestra la consola ligera). Las demos se abren desde la barra superior. |
| `/robot` | Consola ligera sin WebGL, pensada para la pantalla del robot. |
| `/demos/roaster`, `/demos/gatekeeper`, `/demos/bughunter`, `/demos/bumblebee` | Las 4 demos (ver [`DEMOS.md`](./DEMOS.md)). |
| `/face` | Rostro del robot para la pantalla táctil de 7": ojos, estado de voz, letras de Bumblebee, banners de seguridad y botón **PARO**. |
| `/presenter` | Pantalla del presentador: telemetría en vivo y disparo de los gestos de los repos de ensayo. |
| `/props` | Descarga de los props imprimibles a escala 1:1. |
| `/slides` | Slides de la charla (archivos estáticos de `web/public/slides/`). |

## Gestos del robot

El panel «Gestos del Robot» de `/demo` y `/robot` muestra los gestos con su nombre en inglés: **Wave Hello**, **Facepalm**, **Trash Toss**, **Chef Kiss**, **Victory Spin** y **Suspicious Inspect**. Los de Bumblebee aparecen en su demo.

Cada botón dispara la coreografía completa de [`robot-bridge/src/gestures.rs`](../robot-bridge/src/gestures.rs): varios pasos de servos, LED y movimiento del chasis. Sin bridge, el gemelo 3D reproduce los mismos pasos desde [`web/src/lib/gesture-choreographies.generated.ts`](../web/src/lib/gesture-choreographies.generated.ts), que `npm run gen:gestures` genera a partir de `gestures.rs`, e integra la velocidad de cada paso igual que el bridge. `npm run check:gestures` (en el CI) falla si los dos se desincronizan.

## Variables

Las variables de la web están en [`web/.env.example`](../web/.env.example). La API key de Gemini se pega en el navegador y vive en `localStorage`; ver [`ONBOARDING.md`](./ONBOARDING.md#1-requisitos).
