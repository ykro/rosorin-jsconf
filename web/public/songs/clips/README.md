# Clips de Audio para Modo Bumblebee (`web/public/songs/clips/`)

Por respeto a los derechos de autor, los **168 extractos `.mp3`** (de 3 a 6 segundos cada uno) listados en [`../catalog.json`](../catalog.json) están excluidos del repositorio público mediante `.gitignore`.

- **En despliegues locales / escenario**: coloca los archivos `<id>.mp3` (por ejemplo, `en_under_pressure.mp3`, `es_vivir_mi_vida.mp3`) dentro de este directorio `web/public/songs/clips/`.
- **Sin archivos `.mp3` locales**: si clonas el repositorio desde GitHub sin los `.mp3`, `BumblebeeRadioSession` sintetiza automáticamente el sonido de sintonización FM con Web Audio API, muestra la letra/canción en el dial y ejecuta la coreografía de 6 grados de libertad + chasis Mecanum sin errores.
