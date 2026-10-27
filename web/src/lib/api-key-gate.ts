/**
 * Pure state for gating the Gemini interactions on the Gemini API key (no React, testable).
 * The key itself lives in api-key.ts (memory only); this only decides what the page shows.
 */
import type { ApiKeySource, BridgeKeyStatus } from './api-key';

/** `ready`: show the interaction; `loading`: still asking the bridge; `prompt`: ask for the key. */
export type ApiKeyGateState = 'ready' | 'loading' | 'prompt';

export function apiKeyGateState(source: ApiKeySource, bridgeStatus: BridgeKeyStatus): ApiKeyGateState {
  if (source !== 'none') return 'ready';
  if (bridgeStatus === 'idle' || bridgeStatus === 'loading') return 'loading';
  return 'prompt';
}

/** Why there is no key, from what the bridge answered (or that it could not be asked). No hosts. */
export function missingKeyNotice(status: BridgeKeyStatus): string {
  switch (status) {
    case 'idle':
    case 'loading':
      return 'Buscando la API key de Gemini…';
    case 'unreachable':
      return 'No pude pedirle la API key al bridge: no responde. Ingrésala aquí.';
    case 'missing':
      return 'El bridge no tiene GEMINI_API_KEY en web/.env: agrégala ahí o ingrésala aquí.';
    case 'disabled':
    default:
      return 'Ingresa tu API key de Gemini para empezar.';
  }
}
