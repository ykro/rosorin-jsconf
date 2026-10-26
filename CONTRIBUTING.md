# Cómo contribuir

Gracias por el interés. Este repo acompaña la charla «De Web a Physical AI» y se mantiene simple a propósito.

## Antes de empezar

- Abre un *issue* para cambios grandes antes de mandar código.
- Para correr el proyecto sin robot: `./run.sh --mock` (detalles en [`docs/ONBOARDING.md`](./docs/ONBOARDING.md)).
- Requisitos: Node 22 (`.nvmrc`), Rust `>= 1.87` y Python 3.

## Al mandar un *pull request*

1. Corre las verificaciones:
   ```bash
   make test
   make lint
   cd web && npx tsc --noEmit && npm run lint && npm run check:css && npm run check:gestures && npm run build
   ```
2. Si cambias la API, las variables o los flags, actualiza la documentación en el mismo PR (`README.md`, `docs/`, `docs/openapi.yaml` y `skills/`).
3. No subas MP3, API keys ni tokens. No pongas secretos en variables `NEXT_PUBLIC_*`.
4. Los cambios que tocan seguridad del robot (límites, freno, watchdog, E-stop, token) necesitan una explicación de cómo los probaste.
5. Las slides (`slides/`, `web/public/slides/`) son material de la charla: no las cambies sin hablarlo antes.

Las reglas completas para agentes y personas están en [`AGENTS.md`](./AGENTS.md).

## Licencia

Al contribuir aceptas que tu código se publique bajo la licencia MIT del repo ([`LICENSE`](./LICENSE)).
