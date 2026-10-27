import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

type FakeStore = { data: Map<string, string>; writes: string[] };

function fakeStorage(initial: Record<string, string> = {}): FakeStore & Storage {
  const data = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    data,
    writes,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      writes.push(k);
      data.set(k, v);
    },
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size;
    },
  } as unknown as FakeStore & Storage;
}

/** Minimal browser globals for api-key + bridge-config (no DOM needed). */
function installWindow(local: Record<string, string> = {}, session: Record<string, string> = {}) {
  const localStorage = fakeStorage({ ROSORIN_BRIDGE_TOKEN: 'tok-123', ...local });
  const sessionStorage = fakeStorage(session);
  const events: string[] = [];
  (globalThis as Record<string, unknown>).window = {
    location: { href: 'http://localhost:3000/', hostname: 'localhost' },
    localStorage,
    sessionStorage,
    history: { state: null, replaceState: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: (e: Event) => events.push(e.type) > 0,
  };
  return { localStorage, sessionStorage, events };
}

type FetchCall = { url: string; headers: Record<string, string> };
function fakeFetch(body: unknown, calls: FetchCall[], status = 200) {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

let n = 0;
/** Fresh module instance per test: the in-memory key belongs to one page load. */
async function loadApiKey(fetchBody: unknown = { configured: false }, status = 200) {
  n += 1;
  const calls: FetchCall[] = [];
  (globalThis as Record<string, unknown>).fetch = fakeFetch(fetchBody, calls, status);
  const api = (await import(`../api-key.ts?case=${n}`)) as typeof import('../api-key.ts');
  return { api, calls };
}

const LEGACY = ['rosorin_gemini_api_key', 'rosorin_gemini_api_key_origin'];

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

describe('api-key: memory only, never in browser storage', () => {
  it('purges legacy entries from localStorage and sessionStorage on init', async () => {
    const { localStorage, sessionStorage } = installWindow(
      { rosorin_gemini_api_key: 'AIzaOld', rosorin_gemini_api_key_origin: 'launcher' },
      { rosorin_gemini_api_key: 'AIzaOld' },
    );
    const { api } = await loadApiKey();
    assert.equal(api.getEffectiveApiKey(), '');
    for (const k of LEGACY) {
      assert.equal(localStorage.data.has(k), false, k);
      assert.equal(sessionStorage.data.has(k), false, k);
    }
    assert.equal(localStorage.data.get('ROSORIN_BRIDGE_TOKEN'), 'tok-123');
  });

  it('uses the key served by the bridge, with the token, and writes nothing to storage', async () => {
    const { localStorage, sessionStorage } = installWindow();
    const { api, calls } = await loadApiKey({ configured: true, api_key: 'AIzaFromBridge', source: 'GEMINI_API_KEY' });
    api.getApiKeySource(); // first read starts the fetch
    await api.loadApiKeyFromBridge();
    assert.equal(api.getEffectiveApiKey(), 'AIzaFromBridge');
    assert.equal(api.getApiKeySource(), 'bridge');
    assert.equal(api.getBridgeKeyStatus(), 'configured');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/config\/gemini-key$/);
    assert.equal(calls[0].headers['x-bridge-token'], 'tok-123');
    assert.deepEqual(localStorage.writes, []);
    assert.deepEqual(sessionStorage.writes, []);
  });

  it('reports a missing key when the bridge has none', async () => {
    installWindow();
    const { api } = await loadApiKey({ configured: false });
    api.getApiKeySource();
    await api.loadApiKeyFromBridge();
    assert.equal(api.getEffectiveApiKey(), '');
    assert.equal(api.getBridgeKeyStatus(), 'missing');
  });

  it('reports an unreachable bridge without throwing', async () => {
    installWindow();
    const { api } = await loadApiKey({}, 503);
    api.getApiKeySource();
    await api.loadApiKeyFromBridge();
    assert.equal(api.getBridgeKeyStatus(), 'unreachable');
    assert.equal(api.getEffectiveApiKey(), '');
  });

  it('a key typed by hand wins, stays in memory only and can be cleared', async () => {
    const { localStorage, sessionStorage, events } = installWindow();
    const { api } = await loadApiKey({ configured: true, api_key: 'AIzaFromBridge' });
    api.getApiKeySource();
    await api.loadApiKeyFromBridge();
    api.setManualApiKey('  AIzaManual  ');
    assert.equal(api.getEffectiveApiKey(), 'AIzaManual');
    assert.equal(api.getApiKeySource(), 'manual');
    assert.equal(api.getManualApiKey(), 'AIzaManual');
    assert.ok(events.includes('rosorin-api-key-updated'));
    api.setManualApiKey('');
    assert.equal(api.getEffectiveApiKey(), 'AIzaFromBridge');
    assert.deepEqual(localStorage.writes, []);
    assert.deepEqual(sessionStorage.writes, []);
  });

  it('an explicit key passed by the caller wins over everything', async () => {
    installWindow();
    const { api } = await loadApiKey();
    api.setManualApiKey('AIzaManual');
    assert.equal(api.getEffectiveApiKey(' AIzaExplicit '), 'AIzaExplicit');
  });
});
