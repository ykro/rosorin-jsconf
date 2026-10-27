import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { RobotActionHandler, RobotActionResult } from '../types.ts';
import type { SongClip } from '../song-matcher.ts';

type Callbacks = { onmessage: (m: unknown) => void; onclose: (e: unknown) => void; onerror: (e: unknown) => void };
interface FakeSocket {
  cb: Callbacks;
  clientContent: unknown[];
  closed: boolean;
}
const sockets: FakeSocket[] = [];

mock.module('@google/genai', {
  namedExports: {
    Modality: { AUDIO: 'AUDIO' },
    Type: { OBJECT: 'OBJECT', STRING: 'STRING', NUMBER: 'NUMBER', ARRAY: 'ARRAY' },
    GoogleGenAI: class {
      live = {
        connect: async ({ callbacks }: { callbacks: Callbacks }) => {
          const s: FakeSocket = { cb: callbacks, clientContent: [], closed: false };
          sockets.push(s);
          return {
            close() {
              s.closed = true;
            },
            sendRealtimeInput() {},
            sendClientContent(p: unknown) {
              s.clientContent.push(p);
            },
            sendToolResponse() {},
          };
        },
      };
    },
  },
});

// Minimal HTMLAudioElement stand-in: "plays" and ends right away (node has no Audio).
(globalThis as unknown as { Audio: unknown }).Audio = class {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onplaying: (() => void) | null = null;
  currentTime = 0;
  volume = 1;
  src = '';
  constructor(src?: string) {
    this.src = src ?? '';
  }
  play() {
    setTimeout(() => {
      this.onplaying?.();
      setTimeout(() => this.onended?.(), 2);
    }, 1);
    return Promise.resolve();
  }
  pause() {}
  load() {}
  removeAttribute() {}
};

const { setManualApiKey } = await import('../api-key.ts');
const { BumblebeeRadioSession } = await import('../bumblebee-radio.ts');

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const clip = {
  id: 'en_hello',
  title: 'Hello',
  artist: 'Adele',
  lang: 'en',
  lyrics: 'Hello, it is me',
  meanings: ['greeting'],
  role: 'greet',
  gesture: 'bumblebee_romance',
  duration: 2,
  audioUrl: '/songs/clips/en_hello.mp3',
} as unknown as SongClip;

function makeSession() {
  const calls: string[] = [];
  const active: boolean[] = [];
  const ok: RobotActionResult = { ok: true, target: 'robot', message: 'ok' };
  const bridge: RobotActionHandler = {
    triggerGesture: async (name) => {
      calls.push(`gesture:${name}`);
      return ok;
    },
    moveChassis: async () => {
      calls.push('move');
      return ok;
    },
  };
  const session = new BumblebeeRadioSession(
    bridge,
    {
      onConnectionStatus() {},
      onPlaybackStatus() {},
      onConversationActiveChange: (a) => active.push(a),
      onUserTranscript() {},
      onNowPlaying() {},
      onTurnLog() {},
      onMicLevelChange() {},
      onMicWarning() {},
      onClipUnavailable() {},
    },
    [clip]
  );
  return { session, calls, active };
}

const textOf = (p: unknown) =>
  (p as { turns: { parts: { text: string }[] }[] }).turns[0].parts[0].text;

beforeEach(() => {
  sockets.length = 0;
  setManualApiKey('test-key');
});

describe('BumblebeeRadioSession.sendTextTurn: quick phrases keep the conversation open', () => {
  it('opens one live session, sends the phrase as a turn and keeps the session open after the reply', async () => {
    const { session, calls, active } = makeSession();
    assert.equal(await session.sendTextTurn('¡Hola Bumblebee!'), 'live');
    assert.equal(sockets.length, 1);
    assert.equal(textOf(sockets[0].clientContent[0]), '¡Hola Bumblebee!');
    assert.equal(active.at(-1), true, 'the conversation is active even without a mic (node has none)');

    // Bumblebee answers with the tool, then the turn completes: nothing closes the session.
    sockets[0].cb.onmessage({
      toolCall: {
        functionCalls: [
          { id: 'c1', name: 'play_radio_sequence', args: { clip_ids: ['en_hello'], dance_gesture: 'bumblebee_hype', radio_caption: 'hola' } },
        ],
      },
    });
    sockets[0].cb.onmessage({ serverContent: { turnComplete: true } });
    await wait();
    assert.ok(calls.includes('gesture:bumblebee_hype'));
    assert.equal(sockets[0].closed, false);
    assert.equal(active.at(-1), true);

    // The next phrase goes to the SAME session.
    assert.equal(await session.sendTextTurn('Se cayó producción'), 'live');
    assert.equal(sockets.length, 1);
    assert.equal(textOf(sockets[0].clientContent[1]), 'Se cayó producción');
    session.dispose();
  });

  it('answers locally on turnComplete when the model did not call the tool, and stays open', async () => {
    const { session, calls } = makeSession();
    await session.sendTextTurn('¡Hola Bumblebee!');
    sockets[0].cb.onmessage({ serverContent: { turnComplete: true } });
    await wait();
    assert.ok(calls.some((c) => c.startsWith('gesture:')), 'the local matcher answered');
    assert.equal(sockets[0].closed, false);
    session.dispose();
  });

  it('two quick taps open a single session', async () => {
    const { session } = makeSession();
    const [a, b] = await Promise.all([session.sendTextTurn('uno'), session.sendTextTurn('dos')]);
    assert.deepEqual([a, b], ['live', 'live']);
    assert.equal(sockets.length, 1);
    assert.deepEqual(sockets[0].clientContent.map(textOf), ['uno', 'dos']);
    session.dispose();
  });

  it('without an API key it answers locally and opens no session', async () => {
    setManualApiKey('');
    const { session, calls } = makeSession();
    assert.equal(await session.sendTextTurn('¡Hola Bumblebee!'), 'local');
    assert.equal(sockets.length, 0);
    assert.ok(calls.some((c) => c.startsWith('gesture:')));
    session.dispose();
  });
});
