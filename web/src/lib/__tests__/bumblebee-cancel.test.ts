import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { RobotActionHandler, RobotActionResult } from '../types.ts';
import type { SongClip } from '../song-matcher.ts';

type Callbacks = { onmessage: (m: unknown) => void; onclose: (e: unknown) => void; onerror: (e: unknown) => void };
interface FakeSocket {
  cb: Callbacks;
  toolResponses: unknown[];
}
const sockets: FakeSocket[] = [];

mock.module('@google/genai', {
  namedExports: {
    Modality: { AUDIO: 'AUDIO' },
    Type: { OBJECT: 'OBJECT', STRING: 'STRING', NUMBER: 'NUMBER', ARRAY: 'ARRAY' },
    GoogleGenAI: class {
      live = {
        connect: async ({ callbacks }: { callbacks: Callbacks }) => {
          const s: FakeSocket = { cb: callbacks, toolResponses: [] };
          sockets.push(s);
          return {
            close() {},
            sendRealtimeInput() {},
            sendClientContent() {},
            sendToolResponse(p: unknown) {
              s.toolResponses.push(p);
            },
          };
        },
      };
    },
  },
});

process.env.NEXT_PUBLIC_GEMINI_API_KEY = 'test-key';
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
  const playback: string[] = [];
  const session = new BumblebeeRadioSession(
    bridge,
    {
      onConnectionStatus() {},
      onPlaybackStatus: (s) => playback.push(s),
      onConversationActiveChange() {},
      onUserTranscript() {},
      onNowPlaying() {},
      onTurnLog() {},
      onMicLevelChange() {},
      onMicWarning() {},
      onClipUnavailable() {},
    },
    [clip]
  );
  return { session, calls, playback };
}

const playCall = (id: string) => ({
  toolCall: {
    functionCalls: [
      { id, name: 'play_radio_sequence', args: { clip_ids: ['en_hello'], dance_gesture: 'bumblebee_hype', radio_caption: 'hola' } },
    ],
  },
});

beforeEach(() => {
  sockets.length = 0;
});

describe('BumblebeeRadioSession: toolCallCancellation (R6)', () => {
  it('cuts a cancelled sequence that has not started and does not answer the cancelled id', async () => {
    const { session, calls, playback } = makeSession();
    assert.equal(await session.startRadioConversation(), true);
    const sock = sockets[0];
    sock.cb.onmessage(playCall('t1'));
    sock.cb.onmessage({ toolCallCancellation: { ids: ['t1'] } }); // barge-in while tuning
    await wait();
    assert.deepEqual(calls, [], 'the robot must not dance for a cancelled call');
    assert.equal(sock.toolResponses.length, 0, 'no response for a cancelled id');
    assert.equal(playback.at(-1), 'idle');
    session.dispose();
  });

  it('ignores a call whose id was cancelled before it was processed', async () => {
    const { session, calls } = makeSession();
    await session.startRadioConversation();
    const sock = sockets[0];
    sock.cb.onmessage({ toolCallCancellation: { ids: ['t2'] } });
    sock.cb.onmessage(playCall('t2'));
    await wait();
    assert.deepEqual(calls, []);
    assert.equal(sock.toolResponses.length, 0);
    session.dispose();
  });
});
