import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { RobotActionHandler, RobotActionResult } from '../types.ts';
import type { SongClip } from '../song-matcher.ts';

type Callbacks = { onmessage: (m: unknown) => void; onclose: (e: unknown) => void; onerror: (e: unknown) => void };
interface FakeSocket {
  cb: Callbacks;
  audio: string[];
  toolResponses: { functionResponses: { response: { message?: string } }[] }[];
}
const sockets: FakeSocket[] = [];

mock.module('@google/genai', {
  namedExports: {
    Modality: { AUDIO: 'AUDIO' },
    Type: { OBJECT: 'OBJECT', STRING: 'STRING', NUMBER: 'NUMBER', ARRAY: 'ARRAY' },
    GoogleGenAI: class {
      live = {
        connect: async ({ callbacks }: { callbacks: Callbacks }) => {
          const s: FakeSocket = { cb: callbacks, audio: [], toolResponses: [] };
          sockets.push(s);
          return {
            close() {},
            sendRealtimeInput(p: { audio?: { data: string } }) {
              if (p.audio) s.audio.push(p.audio.data);
            },
            sendClientContent() {},
            sendToolResponse(p: FakeSocket['toolResponses'][number]) {
              s.toolResponses.push(p);
            },
          };
        },
      };
    },
  },
});

/** An "audio element" that keeps playing until paused (the song is long). */
const playing = new Set<object>();
(globalThis as unknown as { Audio: unknown }).Audio = class {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onplaying: (() => void) | null = null;
  src: string;
  constructor(src = '') {
    this.src = src;
  }
  play() {
    playing.add(this);
    setTimeout(() => this.onplaying?.(), 1);
    return Promise.resolve();
  }
  pause() {
    playing.delete(this);
  }
};

const { setManualApiKey } = await import('../api-key.ts');
const { BumblebeeRadioSession } = await import('../bumblebee-radio.ts');

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const clip = {
  id: 'en_anti_hero',
  title: 'Anti-Hero',
  artist: 'Taylor Swift',
  lang: 'en',
  lyrics: "It's me, hi, I'm the problem, it's me",
  meanings: ['self-blame'],
  role: 'joke',
  gesture: 'bumblebee_sassy',
  duration: 3,
  audioUrl: '/songs/clips/en_anti_hero.mp3',
} as unknown as SongClip;

function makeSession() {
  const gestures: string[] = [];
  const barge: string[] = [];
  const ok: RobotActionResult = { ok: true, target: 'robot', message: 'ok' };
  const bridge: RobotActionHandler = {
    triggerGesture: async (name) => {
      gestures.push(name);
      return ok;
    },
    moveChassis: async () => ok,
  };
  const session = new BumblebeeRadioSession(
    bridge,
    {
      onConnectionStatus() {},
      onPlaybackStatus() {},
      onConversationActiveChange() {},
      onUserTranscript() {},
      onNowPlaying() {},
      onTurnLog() {},
      onMicLevelChange() {},
      onMicWarning() {},
      onClipUnavailable() {},
      onBargeIn: (src) => barge.push(src),
    },
    [clip]
  );
  return { session, gestures, barge };
}

const toolCall = (id: string) => ({
  toolCall: {
    functionCalls: [
      { id, name: 'play_radio_sequence', args: { clip_ids: ['en_anti_hero'], dance_gesture: 'bumblebee_sassy', radio_caption: 'yo' } },
    ],
  },
});

/** A mic frame of constant amplitude `rms` (2048 samples at 48 kHz, ~43 ms). */
const frame = (rms: number) => ({ samples: new Float32Array(2048).fill(rms), rms, sampleRate: 48000 });
const isSilence = (b64: string) => Buffer.from(b64, 'base64').every((byte) => byte === 0);

// The node test runner has no mic: drive the private frame handler directly.
type MicDriven = { onMicFrame(f: ReturnType<typeof frame>, rate: number): void };

beforeEach(() => {
  sockets.length = 0;
  playing.clear();
  setManualApiKey('test-key');
});

describe('Bumblebee does not answer its own song', () => {
  it('a tool call with no user turn since the last song is ignored', async () => {
    const { session, gestures } = makeSession();
    await session.sendTextTurn('Se cayó producción');
    sockets[0].cb.onmessage(toolCall('c1'));
    await wait();
    assert.equal(gestures.length, 1, 'the real answer plays');
    session.stopCurrentPlayback();
    sockets[0].cb.onmessage({ serverContent: { turnComplete: true } });

    // The model "continues" on its own, with no user input in between.
    sockets[0].cb.onmessage(toolCall('c2'));
    await wait();
    assert.equal(gestures.length, 1, 'nothing else plays');
    const last = sockets[0].toolResponses.at(-1)!.functionResponses[0].response.message ?? '';
    assert.match(last, /has not said anything/);
    session.dispose();
  });

  it('an input transcription that is the lyric just played is discarded', async () => {
    const { session, gestures } = makeSession();
    await session.sendTextTurn('Se cayó producción');
    sockets[0].cb.onmessage(toolCall('c1'));
    await wait();
    session.stopCurrentPlayback(); // song over; the mic still hears its tail
    sockets[0].cb.onmessage({ serverContent: { turnComplete: true } });
    sockets[0].cb.onmessage({ serverContent: { inputTranscription: { text: "I'm the problem it's me" } } });
    sockets[0].cb.onmessage({ serverContent: { turnComplete: true } });
    sockets[0].cb.onmessage(toolCall('c2'));
    await wait();
    assert.equal(gestures.length, 1, 'the echoed lyric is not a user turn');
    session.dispose();
  });

  it('while the clip plays the mic sends silence; talking over it cuts the song and streams the voice', async () => {
    const { session, barge } = makeSession();
    await session.sendTextTurn('Hola');
    sockets[0].cb.onmessage(toolCall('c1'));
    await wait();
    assert.equal(playing.size, 1, 'the clip is playing');
    const mic = session as unknown as MicDriven;

    await wait(400); // past the barge-in warm-up
    for (let i = 0; i < 15; i++) mic.onMicFrame(frame(0.02), 48000); // the song's echo
    assert.ok(sockets[0].audio.slice(-15).every(isSilence), 'Gemini never hears the song');
    assert.equal(playing.size, 1);

    for (let i = 0; i < 10; i++) mic.onMicFrame(frame(0.15), 48000); // the user, loud and clear
    assert.deepEqual(barge, ['voice']);
    assert.equal(playing.size, 0, 'the song was cut');
    assert.ok(!isSilence(sockets[0].audio.at(-1)!), 'the voice is streamed');
    session.dispose();
  });

  it('a manual interruption cuts the song and reopens the mic at once', async () => {
    const { session, barge } = makeSession();
    await session.sendTextTurn('Hola');
    sockets[0].cb.onmessage(toolCall('c1'));
    await wait();
    await session.interrupt();
    assert.deepEqual(barge, ['manual']);
    assert.equal(playing.size, 0);
    const mic = session as unknown as MicDriven;
    mic.onMicFrame(frame(0.15), 48000);
    assert.ok(!isSilence(sockets[0].audio.at(-1)!), 'no echo tail after a manual interruption');
    session.dispose();
  });
});
