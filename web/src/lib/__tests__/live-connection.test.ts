import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

type Callbacks = {
  onmessage: (m: unknown) => void;
  onerror: (e: unknown) => void;
  onclose: (e: unknown) => void;
};
interface FakeSocket {
  cb: Callbacks;
  closed: boolean;
  config: { sessionResumption?: { handle?: string } };
  sentToolResponses: unknown[];
}

const sockets: FakeSocket[] = [];
/** What the next `connect()` does: open normally or close right away with code 1011. */
let behavior: 'ok' | 'earlyClose1011' = 'ok';

mock.module('@google/genai', {
  namedExports: {
    GoogleGenAI: class {
      live = {
        connect: async ({ config, callbacks }: { config: FakeSocket['config']; callbacks: Callbacks }) => {
          const s: FakeSocket = { cb: callbacks, closed: false, config, sentToolResponses: [] };
          sockets.push(s);
          if (behavior === 'earlyClose1011') callbacks.onclose({ code: 1011, reason: 'internal' });
          return {
            close: () => {
              s.closed = true;
            },
            sendClientContent() {},
            sendRealtimeInput() {},
            sendToolResponse(p: unknown) {
              s.sentToolResponses.push(p);
            },
          };
        },
      };
    },
  },
});

const { LiveConnection, parseDurationMs } = await import('../live-connection.ts');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeConnection(opts: { active: () => boolean; maxReconnects?: number }) {
  const statuses: string[] = [];
  const lost: string[] = [];
  const lc = new LiveConnection({
    label: 'test',
    buildConfig: () => ({}),
    onMessage() {},
    onStatus: (s) => statuses.push(s),
    onLost: (r) => lost.push(r),
    shouldReconnect: opts.active,
    maxReconnects: opts.maxReconnects,
  });
  return { lc, statuses, lost };
}

afterEach(() => {
  sockets.length = 0;
  behavior = 'ok';
});

describe('LiveConnection: first connection (R1)', () => {
  it('a non-fatal early close on the first connect reports error and never retries in the background', async () => {
    behavior = 'earlyClose1011';
    let active = true;
    const { lc, statuses } = makeConnection({ active: () => active });
    const ok = await lc.ensure('k');
    assert.equal(ok, false);
    active = false; // what startContinuousConversation does when ensure() fails
    behavior = 'ok';
    await wait(900); // longer than the first backoff step (600 ms)
    assert.equal(sockets.length, 1, 'no orphan reconnect socket');
    assert.equal(lc.isOpen, false);
    assert.deepEqual(statuses, ['connecting', 'error']);
    assert.ok(!statuses.includes('live'), 'the UI must not end in "live" next to the error');
  });

  it('a scheduled reconnect re-checks shouldReconnect() when the timer fires', async () => {
    let active = true;
    const { lc, statuses } = makeConnection({ active: () => active });
    assert.equal(await lc.ensure('k'), true);
    sockets[0].cb.onclose({ code: 1011, reason: 'x' }); // unexpected close: backoff 600 ms
    assert.equal(statuses.at(-1), 'reconnecting');
    active = false; // the conversation ended while waiting
    await wait(900);
    assert.equal(sockets.length, 1, 'the timer must not open a socket nobody wants');
    assert.equal(statuses.at(-1), 'disconnected');
  });

  it('retries unexpected closes with backoff and then gives up', async () => {
    const { lc, statuses, lost } = makeConnection({ active: () => true, maxReconnects: 1 });
    await lc.ensure('k');
    behavior = 'earlyClose1011';
    sockets[0].cb.onclose({ code: 1011, reason: 'x' });
    await wait(900);
    assert.equal(sockets.length, 2);
    assert.equal(statuses.at(-1), 'error');
    assert.equal(lost.length, 1);
  });
});

describe('LiveConnection: goAway (R7)', () => {
  it('parses protobuf durations', () => {
    assert.equal(parseDurationMs('10s'), 10000);
    assert.equal(parseDurationMs('1.5s'), 1500);
    assert.equal(parseDurationMs(undefined), null);
    assert.equal(parseDurationMs('soon'), null);
  });

  it('reconnects right away when idle, reusing the resumption handle', async () => {
    const { lc } = makeConnection({ active: () => true });
    await lc.ensure('k');
    sockets[0].cb.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: 'H1' } });
    sockets[0].cb.onmessage({ goAway: { timeLeft: '10s' } });
    await wait(10);
    assert.equal(sockets.length, 2);
    assert.equal(sockets[0].closed, true);
    assert.equal(sockets[1].config.sessionResumption?.handle, 'H1');
  });

  it('waits for the streaming turn to finish before swapping sockets', async () => {
    const { lc } = makeConnection({ active: () => true });
    await lc.ensure('k');
    sockets[0].cb.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AA', mimeType: 'audio/pcm' } }] } } });
    sockets[0].cb.onmessage({ goAway: { timeLeft: '10s' } });
    await wait(10);
    assert.equal(sockets.length, 1, 'audio still streaming: keep the socket');
    assert.equal(sockets[0].closed, false);
    sockets[0].cb.onmessage({ serverContent: { turnComplete: true } });
    await wait(10);
    assert.equal(sockets.length, 2, 'turn over: reconnect now');
    assert.equal(sockets[0].closed, true);
  });

  it('does not swap sockets while a tool response is still pending', async () => {
    const { lc } = makeConnection({ active: () => true });
    await lc.ensure('k');
    sockets[0].cb.onmessage({ toolCall: { functionCalls: [{ id: 'c1', name: 'move_chassis', args: {} }] } });
    sockets[0].cb.onmessage({ serverContent: { turnComplete: true } });
    sockets[0].cb.onmessage({ goAway: { timeLeft: '10s' } });
    await wait(10);
    assert.equal(sockets.length, 1, 'tool call c1 not answered yet');
    assert.equal(lc.sendToolResponse({ functionResponses: [{ id: 'c1', name: 'move_chassis', response: {} }] }), true);
    assert.equal(sockets[0].sentToolResponses.length, 1, 'the response goes to the socket that asked for it');
    await wait(10);
    assert.equal(sockets.length, 2);
  });

  it('reconnects anyway shortly before the deadline', async () => {
    const { lc } = makeConnection({ active: () => true });
    await lc.ensure('k');
    sockets[0].cb.onmessage({ serverContent: { modelTurn: { parts: [] } } });
    sockets[0].cb.onmessage({ goAway: { timeLeft: '1.6s' } }); // deadline - 1.5 s margin = 100 ms
    await wait(20);
    assert.equal(sockets.length, 1);
    await wait(200);
    assert.equal(sockets.length, 2);
  });

  it('drops a rejected resumption handle after the first failed resume', async () => {
    const { lc } = makeConnection({ active: () => true });
    await lc.ensure('k');
    sockets[0].cb.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: 'H-stale' } });
    behavior = 'earlyClose1011';
    sockets[0].cb.onmessage({ goAway: { timeLeft: '10s' } });
    await wait(10);
    assert.equal(sockets[1].config.sessionResumption?.handle, 'H-stale');
    behavior = 'ok';
    await wait(800); // first backoff step
    assert.equal(sockets.length, 3);
    assert.equal(sockets[2].config.sessionResumption?.handle, undefined, 'fresh session, not the stale handle');
    assert.equal(lc.isOpen, true);
  });
});
