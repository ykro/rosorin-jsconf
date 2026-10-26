import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/** Minimal browser globals for bridge-config / robot-client (no DOM needed). */
function installWindow(href: string, stored: Record<string, string> = {}) {
  const store = new Map(Object.entries(stored));
  const replaced: string[] = [];
  const url = new URL(href);
  (globalThis as Record<string, unknown>).window = {
    location: { href, hostname: url.hostname },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    history: { state: null, replaceState: (_s: unknown, _t: string, u: string) => void replaced.push(u) },
    dispatchEvent: () => true,
    addEventListener() {},
    removeEventListener() {},
  };
  return { store, replaced };
}

let n = 0;
/** Fresh module instance per test (the URL parameters are consumed once per page load). */
async function loadConfig() {
  n += 1;
  return import(`../bridge-config.ts?case=${n}`) as Promise<typeof import('../bridge-config.ts')>;
}

const TOKEN = 'ROSORIN_BRIDGE_TOKEN';
const URL_KEY = 'ROSORIN_BRIDGE_URL';

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

describe('bridge-config: token in the URL fragment', () => {
  it('stores #token= and removes it from the address bar', async () => {
    const { store, replaced } = installWindow('http://localhost:3000/#token=s3cret');
    const cfg = await loadConfig();
    assert.equal(cfg.getBridgeToken(), 's3cret');
    assert.equal(store.get(TOKEN), 's3cret');
    assert.deepEqual(replaced, ['/']);
  });

  it('keeps the rest of the path, query and fragment', async () => {
    const { replaced } = installWindow('http://localhost:3000/face?lite=1#token=abc&view=hud');
    const cfg = await loadConfig();
    assert.equal(cfg.getBridgeToken(), 'abc');
    assert.deepEqual(replaced, ['/face?lite=1#view=hud']);
  });

  it('still accepts ?token= for compatibility', async () => {
    const { replaced } = installWindow('http://localhost:3000/demos/roaster?token=legacy&lite=1');
    const cfg = await loadConfig();
    assert.equal(cfg.getBridgeToken(), 'legacy');
    assert.deepEqual(replaced, ['/demos/roaster?lite=1']);
  });

  it('#token=reset clears it', async () => {
    const { store } = installWindow('http://localhost:3000/#token=reset', { [TOKEN]: 'old' });
    const cfg = await loadConfig();
    assert.equal(cfg.getBridgeToken(), '');
    assert.equal(store.has(TOKEN), false);
  });
});

describe('bridge-config: ?bridge= never carries the old token to another host (R2)', () => {
  it('clears the stored token when ?bridge= points to a different host', async () => {
    const { store } = installWindow('http://localhost:3000/?bridge=http://192.168.1.77:9000', { [TOKEN]: 'old' });
    const cfg = await loadConfig();
    assert.equal(cfg.resolveBridgeUrl(), 'http://192.168.1.77:9000');
    assert.equal(cfg.getBridgeToken(), '', 'the old token must not reach the new host');
    assert.equal(store.has(TOKEN), false);
  });

  it('keeps a new token that comes in the same URL (run.sh with robot)', async () => {
    installWindow('http://localhost:3000/?bridge=http://192.168.1.77:9000#token=fresh', { [TOKEN]: 'old' });
    const cfg = await loadConfig();
    assert.equal(cfg.resolveBridgeUrl(), 'http://192.168.1.77:9000');
    assert.equal(cfg.getBridgeToken(), 'fresh');
  });

  it('keeps the token when the host does not change', async () => {
    installWindow('http://localhost:3000/?bridge=http://localhost:9000', { [TOKEN]: 'same' });
    const cfg = await loadConfig();
    assert.equal(cfg.getBridgeToken(), 'same');
  });

  it('the settings panel clears the token when the URL moves to another host', async () => {
    const { store } = installWindow('http://localhost:3000/', {
      [TOKEN]: 'old',
      [URL_KEY]: 'http://192.168.1.10:9000',
    });
    const cfg = await loadConfig();
    assert.equal(cfg.setStoredBridgeUrl('http://192.168.1.10:9000/'), false, 'same host');
    assert.equal(store.get(TOKEN), 'old');
    assert.equal(cfg.setStoredBridgeUrl('http://10.0.0.5:9000'), true);
    assert.equal(store.has(TOKEN), false);
  });
});

describe('robot-client: blocked movements (new bridge contract)', () => {
  async function postWith(body: unknown) {
    installWindow('http://localhost:3000/');
    (globalThis as Record<string, unknown>).fetch = async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    n += 1;
    const rc = (await import(`../robot-client.ts?case=${n}`)) as typeof import('../robot-client.ts');
    return rc.createBridgeActionHandler(new rc.RobotBridgeClient('http://localhost:9000')).moveChassis(0.1, 0, 0, 500);
  }

  it('turns blocked: "braked" (HTTP 200) into an error result', async () => {
    const r = await postWith({ status: 'ok', action: 'cmd_vel', blocked: 'braked', telemetry: {} });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'braked');
    assert.match(r.message, /no se movió/);
  });

  it('maps lidar_stale and worker_dead, and unknown reasons to "blocked"', async () => {
    assert.equal((await postWith({ status: 'ok', blocked: 'lidar_stale' })).code, 'lidar_stale');
    assert.equal((await postWith({ status: 'ok', blocked: 'worker_dead' })).code, 'worker_dead');
    assert.equal((await postWith({ status: 'ok', blocked: 'something_new' })).code, 'blocked');
  });

  it('tolerates old bridges without the field and blocked: null', async () => {
    assert.equal((await postWith({ status: 'ok', action: 'cmd_vel', telemetry: {} })).ok, true);
    assert.equal((await postWith({ status: 'ok', blocked: null })).ok, true);
  });
});
