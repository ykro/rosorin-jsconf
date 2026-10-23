# Guía de Demos Interactivos

![Mapa de los 4 Demos Interactivos](./assets/demos-map.svg)

Los **4 demos interactivos** combinan contexto técnico o musical real, conversación en vivo con **Gemini 3.8 Live** (`16 kHz` entrada / `24 kHz` salida) y actuación física coordinada en el **Hiwonder ROSOrin Pro** (o en su clon 3D en Three.js).

---

## Controles Comunes en Todos los Demos

- **Inicio con un clic**: Al pulsar el botón principal de cada demo, el robot ejecuta la coreografía física correspondiente, responde y deja el micrófono abierto en modo manos libres.
- **Interrupción en vivo (*Barge-In*)**: Puedes hablar fuerte frente al micrófono mientras el robot habla o pulsar **Interrumpir** para vaciar la cola de audio en `< 20 ms`.
- **Detener conversación**: El botón rojo detiene el stream de micrófono y cierra la sesión activa.
- **Cambio de ruta seguro**: Al navegar a otra pestaña en la barra superior (`TopNav`), cualquier conversación o canción activa se detiene automáticamente.

---

## Demo A · Repo Roaster (`/demos/roaster`)

- **Objetivo**: Analizar un repositorio de GitHub y expresar físicamente el veredicto con el brazo de 6 grados de libertad y las llantas Mecanum (`facepalm`, `trash_toss`, `chef_kiss`, `suspicious_inspect`, `victory_spin`).
- **Herramienta de Gemini Live**: `express_verdict({ gesture, mood, verdict_headline })`.
- **Repositorios preconfigurados**:
  - `facebook/react`
  - `vercel/next.js`
  - `denoland/deno`
  - `ykro/rosorin-jsconf`
- **Flujo en vivo**:
  1. Selecciona un repositorio y pulsa **Analizar y Roastear**.
  2. Pregúntale por voz o con los botones rápidos: *«Dame más detalles técnicos de lo que encontraste»* o *«¿Cuál es el problema más crítico y cómo me recomiendas arreglarlo?»*.

---

## Demo B · Physical CI/CD Gatekeeper (`/demos/gatekeeper`)

- **Objetivo**: El robot sostiene físicamente la tarjeta **Production Deploy Key** en su pinza paralela (**Servo ID 10**, pulso cerrado `680`). Al evaluar un Pull Request, decide si gira la base hacia la bandeja verde de **APROBADO** (`joint1 = 680`) o hacia la bandeja roja de **RECHAZADO** (`joint1 = 260`) y abre la pinza (pulso `220`) para soltar físicamente la llave.
- **Herramienta de Gemini Live**: `release_deploy_key({ decision: "approve" | "reject", reason_es })`.
- **Botones de preparación física**:
  - **Centrar Robot**: Regresa el chasis y el brazo a la posición neutral (`home`).
  - **Sujetar Llave**: Coloca el brazo en pose de custodia (`gatekeeper_hold`) y cierra la pinza (`ID 10 = 680`).
- **Pull Requests incluidos**:
  1. `facebook/react#28912` *(Rechazar — sin plan de rollback ni cobertura suficiente)*
  2. `vercel/next.js#64501` *(Aprobar — suite E2E en verde y canary verificado)*
  3. `denoland/deno#23415` *(Aprobar — pruebas deterministas completas)*

---

## Demo C · Spatial Bug Hunter (`/demos/bughunter`)

- **Objetivo**: Frente al robot se ubican 3 tótems físicos a `42 cm` de distancia:
  - **Cloud Run** (Izquierda, `Y = +20 cm`, Azul `#1A73E8`)
  - **Gemini Live** (Centro, `Y = 0 cm`, Verde `#1E8E3E`)
  - **Firestore** (Derecha, `Y = -20 cm`, Amarillo `#F9AB00`)
  Al analizar un incidente de producción, el robot se desplaza lateralmente con sus llantas Mecanum (*strafe*) y apunta con el brazo al servicio culpable.
- **Herramienta de Gemini Live**: `point_at_service_totem({ service: "cloud_run" | "gemini_live" | "firestore", diagnosis_es })`.
- **Incidentes incluidos**:
  1. `vercel/next.js#54280` → **Cloud Run** *(Fuga de memoria / contenedor supera 512 MiB)*
  2. `googleapis/js-genai#142` → **Gemini Live** *(Cola de audio PCM 24 kHz no vaciada tras barge-in)*
  3. `firebase/firebase-js-sdk#7984` → **Firestore** *(Consulta rechazada por falta de índice compuesto)*

---

## Demo D · Modo Bumblebee Radio (`/demos/bumblebee`)

- **Objetivo**: Inspirado en Bumblebee, la caja de voz del robot está dañada y **solo puede comunicarse sintonizando fragmentos de canciones reales** mientras baila con el brazo de 6 ejes y las ruedas Mecanum.
- **Catálogo musical bilingüe (`web/public/songs/`)**:
  - **171 fragmentos verificados** (`MP3` con letras sincronizadas en `web/public/songs/catalog.json`): **85 en español** y **86 en inglés**.
- **Coreografías físicas de baile (`robot-bridge/src/gestures.rs`)**:
  - `bumblebee_hype` — Brazos arriba y giro festivo Mecanum
  - `bumblebee_groove` — Desplazamiento lateral rítmico (*funk strafe*)
  - `bumblebee_rock_out` — *Headbanging* de hombro/codo y sacudida de chasis
  - `bumblebee_romance` — Vaivén suave en frecuencia FM nocturna
  - `bumblebee_sassy` — Giro con actitud y pose de pinza
  - `bumblebee_sad_droop` — Hombros caídos y violines tristes
- **Herramienta de Gemini Live**: `play_radio_sequence({ clip_ids, dance_gesture, radio_caption })`.
- **Flujo en vivo**:
  1. Pulsa el botón único **«📻 Iniciar Conversación Musical»**.
  2. Háblale por el micrófono o selecciona una frase rápida (*«¡Hola Bumblebee! ¿Listo para romperla en el escenario?»*, *«El deploy en viernes salió perfecto a la primera»*, *«Se cayó producción y nadie sabe por qué»*).
  3. El robot reproduce el barrido de estática FM, sintoniza la canción exacta, muestra la letra en `/face` y ejecuta la coreografía de baile en el robot físico y en el clon 3D.
  4. También puedes explorar y disparar manualmente cualquiera de los **171 clips** desde el **Jukebox Musical** filtrando por idioma (`Español` / `English`), emoción o letra.

---

## Props Físicos Imprimibles 1:1

El archivo PDF calibrado en milímetros para imprimir en Carta/A4 al `100%` se encuentra en:
- [`docs/rosorin-stage-props-print.pdf`](./rosorin-stage-props-print.pdf) (incluye la Llave de Deploy doble cara con pestaña de `22 mm` para el Servo ID 10, los 2 tapetes de bandeja Aprobado/Rechazado y los 3 tótems plegables de mesa).
