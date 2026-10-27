/**
 * Keeps Bumblebee from hearing itself.
 *
 * The song clips play through the laptop speakers and the laptop mic hears them: streamed to
 * Gemini Live they read as user speech, so Bumblebee "answers" its own song, and with the mic
 * simply muted during playback nobody can interrupt it. `EchoGate` is a half-duplex gate with a
 * local barge-in detector: while a clip plays (and for a short tail after) the mic is NOT
 * streamed, but its level is compared against the echo level measured during that same playback;
 * sustained energy clearly above the echo is the user talking over the song.
 */

export type EchoGateState = 'open' | 'playing' | 'tail';

export interface EchoGateDecision {
  /** Stream this frame to Gemini Live as real audio (otherwise send silence). */
  send: boolean;
  /** The user started talking over the clip: cut it and open the mic. Fires once per playback. */
  bargeIn: boolean;
  /** Sustained speech while the gate is open (a real user turn). Fires once per utterance. */
  userSpeech: boolean;
}

export const ECHO_GATE_DEFAULTS = {
  /** Mic stays closed this long after a clip ends (speaker/room tail, output latency). */
  tailMs: 900,
  /** No barge-in during the first part of a clip, while the echo estimate settles. */
  warmupMs: 350,
  /** Sustained energy needed to count as a barge-in / as user speech. */
  bargeInMs: 280,
  speechMs: 200,
  /** Barge-in threshold: this many times the echo level measured during playback… */
  echoFactor: 2.6,
  /** …and this many times the room noise floor, and never below `minBargeRms`. */
  noiseFactor: 4,
  minBargeRms: 0.035,
  /** User speech while open: above the noise floor by this factor and above `minSpeechRms`. */
  minSpeechRms: 0.012,
  /** Echo estimate smoothing per frame (frames arrive every ~43 ms). */
  echoAlpha: 0.12,
} as const;

export type EchoGateOptions = Partial<{ -readonly [K in keyof typeof ECHO_GATE_DEFAULTS]: number }>;

export class EchoGate {
  private readonly o: { -readonly [K in keyof typeof ECHO_GATE_DEFAULTS]: number };
  private _state: EchoGateState = 'open';
  private playbackStartedAt = 0;
  private tailUntil = 0;
  private echoRms = 0;
  private noiseFloor = 0.004;
  private loudMs = 0;
  private speechMs = 0;
  private bargeFired = false;
  private speechFired = false;

  constructor(opts: EchoGateOptions = {}) {
    this.o = { ...ECHO_GATE_DEFAULTS, ...opts };
  }

  get state(): EchoGateState {
    return this._state;
  }

  /** Echo level measured during the current playback (diagnostics/tests). */
  get echoLevel(): number {
    return this.echoRms;
  }

  /** Current barge-in threshold. */
  get bargeThreshold(): number {
    return Math.max(this.echoRms * this.o.echoFactor, this.noiseFloor * this.o.noiseFactor, this.o.minBargeRms);
  }

  /** A clip (or the FM sweep before it) starts playing. */
  startPlayback(now: number) {
    if (this._state !== 'playing') {
      this.playbackStartedAt = now;
      this.echoRms = 0;
      this.bargeFired = false;
    }
    this._state = 'playing';
    this.loudMs = 0;
  }

  /**
   * Playback ended. `immediate` (a barge-in or a manual interruption) reopens the mic right away;
   * otherwise it stays closed for the tail.
   */
  endPlayback(now: number, immediate = false) {
    if (this._state === 'open') return;
    this.loudMs = 0;
    if (immediate) {
      this._state = 'open';
      this.speechMs = 0;
      this.speechFired = false;
      return;
    }
    this._state = 'tail';
    this.tailUntil = now + this.o.tailMs;
  }

  /** Feeds one mic frame (its RMS and duration) and says what to do with it. */
  onFrame(rms: number, frameMs: number, now: number): EchoGateDecision {
    if (this._state === 'tail' && now >= this.tailUntil) {
      this._state = 'open';
      this.speechMs = 0;
      this.speechFired = false;
    }

    if (this._state === 'playing') {
      const threshold = this.bargeThreshold;
      const warm = now - this.playbackStartedAt >= this.o.warmupMs;
      if (warm && rms > threshold) {
        this.loudMs += frameMs;
      } else {
        this.loudMs = 0;
        // Only frames that are not a barge-in candidate shape the echo estimate.
        this.echoRms = this.echoRms === 0 ? rms : this.echoRms + (rms - this.echoRms) * this.o.echoAlpha;
      }
      if (!this.bargeFired && this.loudMs >= this.o.bargeInMs) {
        this.bargeFired = true;
        this.endPlayback(now, true);
        this.speechFired = true; // the barge-in already counts as this utterance
        return { send: true, bargeIn: true, userSpeech: true };
      }
      return { send: false, bargeIn: false, userSpeech: false };
    }

    if (this._state === 'tail') {
      return { send: false, bargeIn: false, userSpeech: false };
    }

    // Open: track the room noise floor (slow up, fast down) and detect sustained speech.
    if (rms < this.noiseFloor) this.noiseFloor = rms;
    else if (rms < this.noiseFloor * 3) this.noiseFloor += (rms - this.noiseFloor) * 0.02;
    const speaking = rms > Math.max(this.noiseFloor * this.o.noiseFactor, this.o.minSpeechRms);
    if (speaking) {
      this.speechMs += frameMs;
    } else {
      this.speechMs = 0;
      this.speechFired = false;
    }
    let userSpeech = false;
    if (!this.speechFired && this.speechMs >= this.o.speechMs) {
      this.speechFired = true;
      userSpeech = true;
    }
    return { send: true, bargeIn: false, userSpeech };
  }
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s']/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/**
 * True when an input transcription is (mostly) the lyric of a clip that is playing or just
 * played: the mic picked up the song, not the user. Needs at least 2 words and 60 % of them in
 * one of the lyrics.
 */
export function isLyricEcho(transcript: string, lyrics: string[]): boolean {
  const words = normalizeWords(transcript);
  if (words.length < 2 || !lyrics.length) return false;
  for (const lyric of lyrics) {
    const vocab = new Set(normalizeWords(lyric));
    if (!vocab.size) continue;
    const hits = words.filter((w) => vocab.has(w)).length;
    if (hits / words.length >= 0.6) return true;
  }
  return false;
}
