/**
 * Browser-side configuration of the Rust robot bridge (URL, shared token and
 * whether this page should talk to it at all).
 *
 * - `?bridge=<url>` stores a LAN/localhost bridge URL (`?bridge=reset` clears it).
 * - `?token=<t>` stores the bridge token in localStorage and is removed from the
 *   address bar right away (`?token=reset` clears it). The token is never read
 *   from NEXT_PUBLIC_* variables: those end up in the public bundle.
 * - On the public site (any non-local hostname) the page does not contact
 *   localhost:9000 until the presenter enables it (button, `?bridge=` or a token).
 */
export const BRIDGE_URL_STORAGE_KEY = 'ROSORIN_BRIDGE_URL';
export const BRIDGE_TOKEN_STORAGE_KEY = 'ROSORIN_BRIDGE_TOKEN';
export const BRIDGE_ENABLED_STORAGE_KEY = 'ROSORIN_BRIDGE_ENABLED';
export const BRIDGE_CONFIG_EVENT = 'rosorin-bridge-config-updated';

function safeGet(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch (err) {
    console.warn(`[bridge-config] No se pudo leer ${key}:`, err);
    return null;
  }
}

function safeSet(key: string, value: string | null) {
  if (typeof window === 'undefined') return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch (err) {
    console.warn(`[bridge-config] No se pudo guardar ${key}:`, err);
  }
}

function notifyChange() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(BRIDGE_CONFIG_EVENT));
  }
}

export function isPrivateHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

export function isAllowedBridgeUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return isPrivateHost(parsed.hostname);
  } catch {
    return false;
  }
}

let urlParamsConsumed = false;

/** Reads `?bridge=` and `?token=` once per page load; strips the token from the address bar. */
export function consumeBridgeParamsFromUrl() {
  if (typeof window === 'undefined' || urlParamsConsumed) return;
  urlParamsConsumed = true;
  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    return;
  }
  let changed = false;

  const bridge = url.searchParams.get('bridge');
  if (bridge === 'reset') {
    safeSet(BRIDGE_URL_STORAGE_KEY, null);
    changed = true;
  } else if (bridge) {
    if (isAllowedBridgeUrl(bridge)) {
      safeSet(BRIDGE_URL_STORAGE_KEY, bridge);
      changed = true;
    } else {
      console.warn('[bridge-config] ?bridge= ignorado: solo se aceptan URLs de localhost o de la LAN.');
    }
  }

  const token = url.searchParams.get('token');
  if (token !== null) {
    safeSet(BRIDGE_TOKEN_STORAGE_KEY, token === 'reset' || !token.trim() ? null : token.trim());
    url.searchParams.delete('token');
    try {
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    } catch (err) {
      console.warn('[bridge-config] No se pudo quitar ?token= de la barra de direcciones:', err);
    }
    changed = true;
  }

  if (changed) notifyChange();
}

export function getBridgeToken(): string {
  consumeBridgeParamsFromUrl();
  return safeGet(BRIDGE_TOKEN_STORAGE_KEY)?.trim() || '';
}

export function setBridgeToken(token: string | null) {
  safeSet(BRIDGE_TOKEN_STORAGE_KEY, token && token.trim() ? token.trim() : null);
  notifyChange();
}

export function getStoredBridgeUrl(): string {
  consumeBridgeParamsFromUrl();
  const stored = safeGet(BRIDGE_URL_STORAGE_KEY);
  return stored && isAllowedBridgeUrl(stored) ? stored : '';
}

export function setStoredBridgeUrl(url: string | null) {
  if (url && !isAllowedBridgeUrl(url)) {
    throw new Error('Solo se aceptan URLs de localhost o de la red local (192.168.x.x, 10.x.x.x, 172.16-31.x.x).');
  }
  safeSet(BRIDGE_URL_STORAGE_KEY, url || null);
  notifyChange();
}

export function resolveBridgeUrl(): string {
  if (typeof window === 'undefined') {
    return process.env.NEXT_PUBLIC_BRIDGE_URL || 'http://localhost:9000';
  }
  const stored = getStoredBridgeUrl();
  if (stored) return stored.replace(/\/+$/, '');
  if (process.env.NEXT_PUBLIC_BRIDGE_URL) return process.env.NEXT_PUBLIC_BRIDGE_URL.replace(/\/+$/, '');
  const host = window.location.hostname || 'localhost';
  if (isPrivateHost(host) && !host.startsWith('[')) return `http://${host}:9000`;
  return 'http://localhost:9000';
}

export function isPublicSite(): boolean {
  if (typeof window === 'undefined') return false;
  return !isPrivateHost(window.location.hostname || 'localhost');
}

/**
 * Whether this page may contact the bridge. Explicit choice wins; otherwise
 * local/LAN pages connect by default and the public site only when a bridge
 * URL or token has been configured.
 */
export function isBridgeEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  consumeBridgeParamsFromUrl();
  const flag = safeGet(BRIDGE_ENABLED_STORAGE_KEY);
  if (flag === '1') return true;
  if (flag === '0') return false;
  if (!isPublicSite()) return true;
  return Boolean(getStoredBridgeUrl() || getBridgeToken());
}

export function setBridgeEnabled(enabled: boolean) {
  safeSet(BRIDGE_ENABLED_STORAGE_KEY, enabled ? '1' : '0');
  notifyChange();
}

export function onBridgeConfigChange(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (e: StorageEvent) => {
    if (
      e.key === null ||
      e.key === BRIDGE_URL_STORAGE_KEY ||
      e.key === BRIDGE_TOKEN_STORAGE_KEY ||
      e.key === BRIDGE_ENABLED_STORAGE_KEY
    ) {
      cb();
    }
  };
  window.addEventListener(BRIDGE_CONFIG_EVENT, cb);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(BRIDGE_CONFIG_EVENT, cb);
    window.removeEventListener('storage', onStorage);
  };
}
