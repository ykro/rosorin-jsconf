/**
 * Single source of truth for the Gemini API key used by the browser.
 *
 * Priority: explicit value > localStorage (`rosorin_gemini_api_key`) >
 * NEXT_PUBLIC_GEMINI_API_KEY (discouraged: a NEXT_PUBLIC_* value is inlined into the public
 * bundle at build time).
 *
 * The launchers (run.sh, ensayo.sh, demo.sh) read the non-public GEMINI_API_KEY from the
 * environment or web/.env and hand it over once in the URL fragment (`#gemini_key=<k>`, next to
 * `#token=`): the fragment never reaches the server, and the key is stored in localStorage and
 * stripped from the address bar on the first read.
 */
export const API_KEY_STORAGE_KEY = 'rosorin_gemini_api_key';
/** Set to `launcher` when the stored key came from `#gemini_key=` (cleared on manual save). */
export const API_KEY_ORIGIN_STORAGE_KEY = 'rosorin_gemini_api_key_origin';
export const API_KEY_UPDATED_EVENT = 'rosorin-api-key-updated';

export type ApiKeySource = 'none' | 'env' | 'browser' | 'launcher';

let fragmentConsumed = false;

/**
 * Reads `#gemini_key=` once per page load, stores it and removes it from the address bar.
 * `#gemini_key=reset` clears the stored key.
 */
export function consumeApiKeyFromUrl() {
  if (typeof window === 'undefined' || fragmentConsumed) return;
  fragmentConsumed = true;
  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    return;
  }
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
  const key = hashParams.get('gemini_key');
  if (key === null) return;
  try {
    const trimmed = key.trim();
    if (trimmed && trimmed !== 'reset') {
      window.localStorage.setItem(API_KEY_STORAGE_KEY, trimmed);
      window.localStorage.setItem(API_KEY_ORIGIN_STORAGE_KEY, 'launcher');
    } else {
      window.localStorage.removeItem(API_KEY_STORAGE_KEY);
      window.localStorage.removeItem(API_KEY_ORIGIN_STORAGE_KEY);
    }
  } catch (err) {
    console.warn('[api-key] No se pudo guardar la API key del fragmento:', err);
  }
  hashParams.delete('gemini_key');
  const rest = hashParams.toString();
  url.hash = rest ? `#${rest}` : '';
  try {
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch (err) {
    console.warn('[api-key] No se pudo quitar la API key de la barra de direcciones:', err);
  }
  window.dispatchEvent(new Event(API_KEY_UPDATED_EVENT));
}

function readStoredKey(): string {
  if (typeof window === 'undefined') return '';
  consumeApiKeyFromUrl();
  try {
    return window.localStorage.getItem(API_KEY_STORAGE_KEY)?.trim() || '';
  } catch (err) {
    console.warn('[api-key] localStorage no disponible:', err);
    return '';
  }
}

function readEnvKey(): string {
  return process.env.NEXT_PUBLIC_GEMINI_API_KEY?.trim() || '';
}

function readStoredOrigin(): string {
  try {
    return window.localStorage.getItem(API_KEY_ORIGIN_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function getApiKeySource(): ApiKeySource {
  if (readStoredKey()) return readStoredOrigin() === 'launcher' ? 'launcher' : 'browser';
  if (readEnvKey()) return 'env';
  return 'none';
}

export function getStoredApiKey(): string {
  return readStoredKey();
}

export function getEffectiveApiKey(explicitKey?: string): string {
  if (explicitKey?.trim()) return explicitKey.trim();
  return readStoredKey() || readEnvKey();
}

export function saveApiKey(value: string) {
  if (typeof window === 'undefined') return;
  try {
    const trimmed = value.trim();
    if (trimmed) window.localStorage.setItem(API_KEY_STORAGE_KEY, trimmed);
    else window.localStorage.removeItem(API_KEY_STORAGE_KEY);
    window.localStorage.removeItem(API_KEY_ORIGIN_STORAGE_KEY);
  } catch (err) {
    console.warn('[api-key] No se pudo guardar la API key:', err);
  }
  window.dispatchEvent(new Event(API_KEY_UPDATED_EVENT));
}
