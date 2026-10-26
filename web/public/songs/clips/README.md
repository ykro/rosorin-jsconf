# Clips de audio de Bumblebee Radio

Esta carpeta es para los 168 fragmentos `.mp3` que lista [`../catalog.json`](../catalog.json) (95 en español y 73 en inglés, de 2.1 a 9.4 segundos cada uno).

**Los MP3 no se versionan ni se despliegan:**

- `.gitignore` excluye `web/public/songs/clips/*.mp3`, así que al clonar el repo esta carpeta solo trae este README.
- `firebase.json` excluye `songs/clips/**` del hosting, así que el sitio público tampoco los sirve.

**Cómo se comporta la demo:**

- **Sin los MP3** (sitio público o un clon recién hecho): al tocar un clip, la web reproduce un barrido de radio, muestra el aviso «Clip no disponible en esta versión pública: se reproduce un barrido de radio.», mantiene la letra en el dial y el robot (o el gemelo 3D) baila igual.
- **Con los MP3 en local** (`http://localhost:3000`): coloca cada archivo como `<id>.mp3`, con el `id` del catálogo (por ejemplo `en_under_pressure.mp3` o `es_vivir_mi_vida.mp3`). La ruta que usa la web es el campo `audioUrl` de cada entrada, `/songs/clips/<id>.mp3`.

No subas estos archivos al repositorio: son fragmentos de canciones con derechos de autor.
