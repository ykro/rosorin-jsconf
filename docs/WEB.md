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

## STOP y token

- **STOP fijo.** Las páginas con barra superior (`/`, `/demo`, `/robot` y las 4 demos) muestran un botón **STOP** rojo cuando el bridge está habilitado; en `localhost` lo está por defecto. La tecla **Escape** hace lo mismo, salvo mientras escribes en un campo de texto; si el panel del robot está abierto, Escape primero lo cierra. El STOP manda `POST /stop` directo, así que funciona aunque el WebSocket de telemetría esté caído, y también detiene el gemelo 3D.
- **Token.** La web lo toma de `#token=<t>` (lo que imprime `run.sh`) o de `?token=<t>`, lo guarda en `localStorage` y lo quita de la barra. El panel de la píldora del robot dice con qué habla la página («Robot», «Mock», «Sin bridge»), nunca su host ni su IP; si cambias a otro bridge, el token guardado se borra. Los detalles están en [`SECURITY.md`](./SECURITY.md#el-token-en-la-web).
- **Bridge (sin guardar).** La URL del bridge nunca se guarda en el navegador: la IP del robot cambia con cada red. En cada carga la web la resuelve en este orden: `?bridge=<url>` (solo `localhost` o red local; vale para esa carga y se quita de la barra; `?bridge=reset` vuelve al valor por defecto) → si la página se sirve desde un host de la red local (el robot sirviendo la web en `http://<IP>:3000`), ese mismo host en el puerto 9000 → `NEXT_PUBLIC_BRIDGE_URL` del build → `http://localhost:9000`. Una URL guardada por una versión anterior (`ROSORIN_BRIDGE_URL` en `localStorage`) se borra al cargar. La URL que escribas en el panel también vale solo para esa página.
- **Control del robot sin respuesta.** Si la telemetría trae `connected: false` (worker atascado o caído), aparece el banner «El control del robot no responde: chasis bloqueado». Un STOP en ese estado igual enclava la E-stop en el bridge y la web lo marca como enviado, con un aviso de apagar el robot si sigue moviéndose.
- **Atrás sin LiDAR.** Con el robot real el bridge reporta `lidar.uncovered: ["back"]` (atrás lo tapan el chasis y los cables). El panel «Mover Ruedas» avisa que la reversa no frena y el anillo del LiDAR del gemelo 3D deja un hueco detrás del robot. En mock el anillo es de 360°.
- **LiDAR en el gemelo.** Cada sector dibuja lo que reporta el bridge, en el marco del robot (sigue su posición y su giro): un muro rojo a la distancia medida si hay un eco a menos de 0.85 m, una cuña gris «ciego» si el sector cubierto marca 0.0 (ventana tapada o sucia) y nada si el sector no tiene cobertura. El anillo y el abanico se ponen rojos con `obstacle_alert` o con cualquier sector cubierto dentro de los 0.28 m del freno. Si la garra baja frente al LiDAR y la sombra del brazo no está calibrada, aparece como un muro al frente: es una lectura real.
- **«Reconocer» en el gemelo.** En `/demos/gatekeeper` y `/demos/bughunter`, el botón **Reconocer** pide `POST /scan_env` y al lado muestra «Paso i/N», la barra de avance y, al terminar, cada objeto con su ángulo («34° der»), distancia y confianza (o «no encontrado (usa el lado fijo)»). Mientras corre, el brazo del gemelo barre siguiendo la telemetría y se dibuja el campo de visión de la cámara; para abortar, **STOP** o **Escape**. Al terminar, el gemelo dibuja las bandejas y los tótems donde se midieron (`telemetry.scan_env`, en el marco del mundo); sin reconocimiento, en el lado fijo. Necesita el bridge (el robot o `./run.sh --mock`): sin él, el botón queda desactivado y lo explica. Con el bridge conectado, los gestos ya no reproducen la coreografía local en paralelo: el gemelo sigue la telemetría del bridge (que puede apuntar a lo medido).
- **Respuestas bloqueadas.** Si el bridge acepta un movimiento pero responde `blocked` (`braked`, `lidar_stale` o `worker_dead`), la web lo muestra como error y nunca como éxito.

## Atajos de teclado

Funcionan en `/demo`, en las 4 demos y en `/robot`. No actúan mientras escribes en un campo, si hay un diálogo abierto ni con Cmd, Ctrl o Alt ([`keyboard.ts`](../web/src/lib/keyboard.ts)).

| Tecla | Acción |
|---|---|
| `↑` / `↓` | Avanza / retrocede a 0.15 m/s (pulso de 420 ms). Con el robot real atrás no hay LiDAR: la reversa no frena y el panel «Mover Ruedas» lo avisa. |
| `←` / `→` | Strafe a la izquierda / derecha a 0.15 m/s. |
| `Z` / `X` | Gira sobre su eje a la izquierda (antihorario) / derecha (horario), 0.45 rad/s. |
| `1`–`5` / `Q`–`T` | Mueven las articulaciones J1–J5 (+ / −). |
| `O` / `C` | Abre / cierra la pinza. |
| `F`, `G`, `H`, `V` | Gestos `facepalm`, `trash_toss`, `chef_kiss`, `victory_spin`. |
| `0` | Vuelve a `home`. |
| `Esc` | STOP (en todas las páginas con barra superior). |

## Sin WebGL

Si el navegador no tiene WebGL, el simulador muestra «Sin WebGL: el simulador 3D no está disponible» y el resto de la página sigue funcionando: consola Live, botones del robot y STOP. Si el visor falla por otra causa, su error boundary muestra «El simulador 3D falló» con «Reintentar». Un error que tumbe la ruta completa cae en `app/error.tsx`, que conserva la barra superior y ofrece «Reintentar» y, si el bridge está habilitado, **STOP**, que llama directo al bridge.

## Gestos del robot

El panel «Gestos del Robot» de `/demo` y `/robot` muestra los gestos con su nombre en inglés: **Wave Hello**, **Facepalm**, **Trash Toss**, **Chef Kiss**, **Victory Spin** y **Suspicious Inspect**. Los de Bumblebee aparecen en su demo.

Cada botón dispara la coreografía completa de [`robot-bridge/src/gestures.rs`](../robot-bridge/src/gestures.rs): varios pasos de servos, LED y movimiento del chasis. Sin bridge, el gemelo 3D reproduce los mismos pasos desde [`web/src/lib/gesture-choreographies.generated.ts`](../web/src/lib/gesture-choreographies.generated.ts), que `npm run gen:gestures` genera a partir de `gestures.rs`, e integra la velocidad de cada paso igual que el bridge. `npm run check:gestures` (en el CI) falla si los dos se desincronizan.

## Variables

Las variables de la web están en [`web/.env.example`](../web/.env.example).

- **API key de Gemini.** Ponla en el `web/.env` de donde corre el bridge (el robot; la laptop con `--mock`) como `GEMINI_API_KEY`. Los lanzadores la leen con `rosorin_gemini_key` (entorno, luego `web/.env.local`, luego `web/.env`) y se la dan al bridge por entorno. Al cargar, la web la pide a `GET /config/gemini-key` con el token y la tiene **solo en memoria**: nunca va en una URL ni se guarda en `localStorage`, `sessionStorage`, cookies o IndexedDB, y al recargar la vuelve a pedir. Mientras no hay key, cada demo muestra en su zona de interacción **solo** la caja para ingresarla (`ApiKeyGate`): se ocultan la consola de Gemini Live, «Evaluar PR», «Analizar y Roastear», «Diagnosticar y Señalar», los presets, las frases rápidas, el cuadro de texto, «Iniciar Conversación Musical» y el dial de Bumblebee. Siguen visibles la barra superior con STOP, el gemelo 3D, los controles manuales del robot, las coreografías y «Reconocer». Mientras la web todavía le pregunta al bridge muestra «Buscando la API key de Gemini…»; si no la consigue, dice por qué, sin mostrar ninguna IP: «No pude pedirle la API key al bridge: no responde. Ingrésala aquí.», «El bridge no tiene GEMINI_API_KEY en web/.env: agrégala ahí o ingrésala aquí.» o, en una página sin bridge (el sitio público), «Ingresa tu API key de Gemini para empezar.». Al llegar la key (del bridge o pegada con «Usar») la caja desaparece y aparece todo. La key pegada a mano gana sobre la del bridge y también vive solo en memoria. La web ya no lee `NEXT_PUBLIC_GEMINI_API_KEY` y, al cargar, borra las entradas viejas `rosorin_gemini_api_key*` del navegador. Ver [`SECURITY.md`](./SECURITY.md#la-api-key-de-gemini).
