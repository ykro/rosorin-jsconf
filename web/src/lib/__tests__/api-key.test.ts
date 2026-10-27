import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/** Minimal browser globals for api-key (no DOM needed). */
function installWindow(href: string, stored: Record<string, string> = {}) {
  const store = new Map(Object.entries(stored));
  const replaced: string[] = [];
  const events: string[] = [];
  (globalThis as Record<string, unknown>).window = {
    location: { href },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    history: { state: null, replaceState: (_s: unknown, _t: string, u: string) => void replaced.push(u) },
    dispatchEvent: (e: Event) => events.push(e.type) > 0,
  };
  return { store, replaced, events };
}

let n = 0;
/** Fresh module instance per test (the fragment is consumed once per page load). */
async function loadApiKey() {
  n += 1;
  return import(`../api-key.ts?case=${n}`) as Promise<typeof import('../api-key.ts')>;
}

const KEY = 'rosorin_gemini_api_key';
const ORIGIN = 'rosorin_gemini_api_key_origin';

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

describe('api-key: #gemini_key= from the launchers', () => {
  it('stores the key, marks it as launcher and strips only it from the bar', async () => {
    const { store, replaced, events } = installWindow('http://localhost:3000/demo?lite=1#token=t0k&gemini_key=AIzaTest');
    const api = await loadApiKey();
    assert.equal(api.getEffectiveApiKey(), 'AIzaTest');
    assert.equal(api.getApiKeySource(), 'launcher');
    assert.equal(store.get(KEY), 'AIzaTest');
    assert.equal(store.get(ORIGIN), 'launcher');
    assert.deepEqual(replaced, ['/demo?lite=1#token=t0k']);
    assert.ok(events.includes('rosorin-api-key-updated'));
  });

  it('without #gemini_key= keeps the stored key and does not touch the bar', async () => {
    const { replaced } = installWindow('http://localhost:3000/#token=abc', { [KEY]: 'AIzaStored' });
    const api = await loadApiKey();
    assert.equal(api.getEffectiveApiKey(), 'AIzaStored');
    assert.equal(api.getApiKeySource(), 'browser');
    assert.deepEqual(replaced, []);
  });

  it('#gemini_key=reset clears the stored key', async () => {
    const { store } = installWindow('http://localhost:3000/#gemini_key=reset', { [KEY]: 'old', [ORIGIN]: 'launcher' });
    const api = await loadApiKey();
    assert.equal(api.getStoredApiKey(), '');
    assert.equal(store.has(KEY), false);
    assert.equal(store.has(ORIGIN), false);
  });

  it('a manual save clears the launcher mark', async () => {
    const { store } = installWindow('http://localhost:3000/#gemini_key=AIzaLaunch');
    const api = await loadApiKey();
    assert.equal(api.getApiKeySource(), 'launcher');
    api.saveApiKey('AIzaManual');
    assert.equal(store.get(KEY), 'AIzaManual');
    assert.equal(api.getApiKeySource(), 'browser');
  });
});
