/**
 * Single source of truth for the Gemini API key used by the browser.
 *
 * Priority: explicit value > localStorage (`rosorin_gemini_api_key`) >
 * NEXT_PUBLIC_GEMINI_API_KEY (only meant for `next dev` on the presenter laptop:
 * a NEXT_PUBLIC_* value is inlined into the public bundle at build time).
 */
export const API_KEY_STORAGE_KEY = 'rosorin_gemini_api_key';
export const API_KEY_UPDATED_EVENT = 'rosorin-api-key-updated';

export type ApiKeySource = 'none' | 'env' | 'browser';

function readStoredKey(): string {
  if (typeof window === 'undefined') return '';
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

export function getApiKeySource(): ApiKeySource {
  if (readStoredKey()) return 'browser';
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
  } catch (err) {
    console.warn('[api-key] No se pudo guardar la API key:', err);
  }
  window.dispatchEvent(new Event(API_KEY_UPDATED_EVENT));
}
