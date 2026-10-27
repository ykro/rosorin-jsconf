/**
 * Single source of truth for the Gemini API key used by the browser.
 *
 * The key lives ONLY in memory while the page is open: it is never written to localStorage,
 * sessionStorage, cookies or IndexedDB, and never read from a URL. A reload loses it.
 *
 * Priority: explicit value > key typed by hand on this page > key served by the robot bridge
 * (`GET /config/gemini-key`, behind the bridge token; the launchers load GEMINI_API_KEY from
 * web/.env into the bridge's environment). The bridge key is fetched again on every page load,
 * so a reload is seamless when the robot has it; a key typed by hand has to be typed again.
 *
 * NEXT_PUBLIC_GEMINI_API_KEY is not read: a NEXT_PUBLIC_* value would be inlined into the public
 * bundle.
 */
import { BRIDGE_CONFIG_EVENT, getBridgeToken, isBridgeEnabled, resolveBridgeUrl } from './bridge-config';

export const API_KEY_UPDATED_EVENT = 'rosorin-api-key-updated';

/** Entries older versions stored in the browser; purged on every page load. */
export const LEGACY_API_KEY_STORAGE_KEYS = ['rosorin_gemini_api_key', 'rosorin_gemini_api_key_origin'];

export type ApiKeySource = 'none' | 'bridge' | 'manual';

/** What the bridge answered for `/config/gemini-key`. */
export type BridgeKeyStatus = 'idle' | 'loading' | 'configured' | 'missing' | 'unreachable' | 'disabled';

let manualKey = '';
let bridgeKey = '';
let bridgeStatus: BridgeKeyStatus = 'idle';
let inflight: Promise<void> | null = null;
let browserInitDone = false;

function notify() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(API_KEY_UPDATED_EVENT));
}

/** Removes any key an older version left in localStorage or sessionStorage. */
export function purgeLegacyApiKeyStorage() {
  if (typeof window === 'undefined') return;
  for (const storage of ['localStorage', 'sessionStorage'] as const) {
    try {
      const store = window[storage];
      for (const name of LEGACY_API_KEY_STORAGE_KEYS) store?.removeItem(name);
    } catch (err) {
      console.warn(`[api-key] No se pudo limpiar ${storage}:`, err);
    }
  }
}

/** Once per page load: purge legacy storage and start fetching the bridge key. */
function initBrowser() {
  if (typeof window === 'undefined' || browserInitDone) return;
  browserInitDone = true;
  purgeLegacyApiKeyStorage();
  // A token or bridge URL that arrives later (fragment, panel) gets another chance.
  window.addEventListener(BRIDGE_CONFIG_EVENT, () => {
    void loadApiKeyFromBridge({ force: true });
  });
  void loadApiKeyFromBridge();
}

/**
 * Asks the bridge for GEMINI_API_KEY. Never throws; the result is in getBridgeKeyStatus().
 * `fetchImpl` exists for tests.
 */
export function loadApiKeyFromBridge(
  opts: { force?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  if (inflight) return inflight;
  if (!opts.force && bridgeStatus !== 'idle') return Promise.resolve();
  if (typeof window === 'undefined' || !isBridgeEnabled()) {
    bridgeKey = '';
    bridgeStatus = 'disabled';
    notify();
    return Promise.resolve();
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const token = getBridgeToken();
  bridgeStatus = 'loading';
  notify();
  inflight = (async () => {
    try {
      const res = await doFetch(`${resolveBridgeUrl().replace(/\/$/, '')}/config/gemini-key`, {
        headers: token ? { 'x-bridge-token': token } : {},
        cache: 'no-store',
      });
      if (!res.ok) {
        bridgeKey = '';
        bridgeStatus = 'unreachable';
        return;
      }
      const data = (await res.json()) as { configured?: boolean; api_key?: string };
      const key = data.configured && typeof data.api_key === 'string' ? data.api_key.trim() : '';
      bridgeKey = key;
      bridgeStatus = key ? 'configured' : 'missing';
    } catch {
      bridgeKey = '';
      bridgeStatus = 'unreachable';
    } finally {
      inflight = null;
      notify();
    }
  })();
  return inflight;
}

export function getBridgeKeyStatus(): BridgeKeyStatus {
  initBrowser();
  return bridgeStatus;
}

export function getApiKeySource(): ApiKeySource {
  initBrowser();
  if (manualKey) return 'manual';
  if (bridgeKey) return 'bridge';
  return 'none';
}

/** The key typed by hand on this page (memory only), or ''. */
export function getManualApiKey(): string {
  initBrowser();
  return manualKey;
}

export function getEffectiveApiKey(explicitKey?: string): string {
  initBrowser();
  if (explicitKey?.trim()) return explicitKey.trim();
  return manualKey || bridgeKey;
}

/** Sets the key typed by hand. Memory only: it is gone after a reload. '' clears it. */
export function setManualApiKey(value: string) {
  initBrowser();
  manualKey = value.trim();
  notify();
}

/** Test helper: resets the in-memory state as if the page had just loaded. */
export function __resetApiKeyStateForTests() {
  manualKey = '';
  bridgeKey = '';
  bridgeStatus = 'idle';
  inflight = null;
  browserInitDone = false;
}
