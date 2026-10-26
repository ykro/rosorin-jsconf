import {
  Modality,
  Type,
  type FunctionCall,
  type FunctionDeclaration,
  type FunctionResponse,
  type LiveServerMessage,
} from '@google/genai';
import { RobotBridgeClient, createBridgeActionHandler } from './robot-client';
import { stopAllActiveConversations, type StopReason } from './gemini-live';
import type { RobotActionHandler, RobotActionResult } from './types';
import { downsampleFloat32ToInt16_16kHz, int16ToBase64, type PcmWorkletFrame } from './audio-worklet';
import { getEffectiveApiKey } from './api-key';
import { LiveConnection, type LiveStatus } from './live-connection';
import { MicCapture } from './mic-capture';
import { sanitizeTranscriptChunk } from './transcript-filter';
import { cleanIdList, cleanToolText, pickEnum } from './tool-args';
import { matchSongsForPrompt, type MatchState, type SongClip, type SongMatch } from './song-matcher';

export type { SongClip } from './song-matcher';
export { embedQueryVector, cosineSimilarity } from './song-matcher';

export interface RadioTurnLog {
  id: string;
  timestamp: string;
  userText: string;
  clips: SongClip[];
  gesture: string;
  caption: string;
}

export type PlaybackStatus = 'idle' | 'tuning' | 'playing';

export interface BumblebeeCallbacks {
  onConnectionStatus: (status: LiveStatus) => void;
  onPlaybackStatus: (status: PlaybackStatus) => void;
  /** True while the microphone is open and streaming to Gemini Live. */
  onConversationActiveChange: (active: boolean) => void;
  onUserTranscript: (text: string) => void;
  onNowPlaying: (clip: SongClip | null, frequencyMhz: string, caption: string) => void;
  onTurnLog: (turn: RadioTurnLog) => void;
  onMicLevelChange: (level: number) => void;
  onMicWarning: (warning: string | null) => void;
  /** A clip's MP3 could not be played (public build ships without clips); null once a clip plays. */
  onClipUnavailable: (clip: SongClip | null) => void;
}

export const BUMBLEBEE_DANCES = [
  'bumblebee_hype',
  'bumblebee_groove',
  'bumblebee_rock_out',
  'bumblebee_romance',
  'bumblebee_sad_droop',
  'bumblebee_sassy',
] as const;

/** Spanish labels for the dance ids (the ids themselves are API values and do not change). */
export const BUMBLEBEE_DANCE_LABELS: Record<string, string> = {
  bumblebee_hype: 'Fiesta',
  bumblebee_groove: 'Ritmo funk',
  bumblebee_rock_out: 'Cabeceo rockero',
  bumblebee_romance: 'Romántico',
  bumblebee_sad_droop: 'Violines tristes',
  bumblebee_sassy: 'Giro con actitud',
};

/**
 * Declared BLOCKING (no `behavior`): the response is sent as soon as the first
 * dance step reaches the robot (< 1 s); the music keeps playing afterwards.
 */
export const BUMBLEBEE_TOOLS: FunctionDeclaration[] = [
  {
    name: 'play_radio_sequence',
    description:
      'Respond to the user exclusively by tuning the FM radio to play 1 or 2 real song clips (in Spanish or English) from the catalog while dancing with the 6-DOF robotic arm and Mecanum chassis.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        clip_ids: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: '1 or 2 song clip IDs from the catalog whose complete lyrics form your response.',
        },
        dance_gesture: {
          type: Type.STRING,
          enum: [...BUMBLEBEE_DANCES],
          description: 'Physical dance choreography to execute while the song clips play.',
        },
        radio_caption: {
          type: Type.STRING,
          description: 'Short playful radio tuner caption in Spanish (max 10 words).',
        },
      },
      required: ['clip_ids', 'dance_gesture', 'radio_caption'],
    },
  },
];

const IDLE_FREQUENCY = '104.7 FM';
const TAB_HIDDEN_WARNING =
  'La radio se detuvo al cambiar de pestaña para que el robot no responda mientras presentas. Pulsa de nuevo para reanudarla.';
const NO_KEY_WARNING =
  'No hay GEMINI_API_KEY: el micrófono no se abre. Configura la API key arriba, o usa las frases rápidas y el cuadro de texto (búsqueda local).';
const CONNECT_FAILED_WARNING =
  'No se pudo conectar a Gemini Live. Puedes seguir con las frases rápidas o el cuadro de texto.';

/** Only one Bumblebee session may own the mic at a time (module-level registry). */
let activeBumblebeeSession: BumblebeeRadioSession | null = null;

function setActiveBumblebeeSession(session: BumblebeeRadioSession | null) {
  activeBumblebeeSession = session;
}

export function stopActiveBumblebeeSession(reason: StopReason = 'navigation') {
  if (activeBumblebeeSession) {
    activeBumblebeeSession.stopRadioConversation(reason);
    activeBumblebeeSession = null;
  }
}

export class BumblebeeRadioSession {
  private readonly bridge: RobotActionHandler;
  private readonly hudClient = new RobotBridgeClient();
  private readonly callbacks: BumblebeeCallbacks;
  private readonly live: LiveConnection;
  private readonly mic = new MicCapture();
  private catalog: SongClip[] = [];
  private audioCtx: AudioContext | null = null;
  private currentAudioEl: HTMLAudioElement | null = null;
  /** Resolves the clip currently awaited by the sequence loop (used by "Cortar"). */
  private finishCurrentClip: (() => void) | null = null;
  private clipTimer: ReturnType<typeof setTimeout> | null = null;
  /** Incremented on every new sequence or stop; stale loops exit when it changes. */
  private playSeq = 0;
  private isPlayingRadio = false;
  private motionSuppressUntil = 0;
  private conversationActive = false;
  private currentUserTurnText = '';
  private silenceDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private toolHandledCurrentTurn = false;
  private readonly matchState: MatchState = { recentClipIds: [] };
  private danceStepCounter = 0;

  constructor(
    bridge: RobotActionHandler | undefined | null,
    callbacks: BumblebeeCallbacks,
    catalog: SongClip[] = []
  ) {
    this.bridge = bridge || createBridgeActionHandler(new RobotBridgeClient());
    this.callbacks = callbacks;
    this.catalog = catalog;
    this.live = new LiveConnection({
      label: 'bumblebee',
      buildConfig: () => ({
        responseModalities: [Modality.AUDIO],
        systemInstruction: { parts: [{ text: this.buildSystemPrompt() }] },
        speechConfig: {
          languageCode: 'es-US',
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } },
        },
        inputAudioTranscription: {},
        tools: [{ functionDeclarations: BUMBLEBEE_TOOLS }],
      }),
      onMessage: (msg) => this.handleMessage(msg),
      onStatus: (status) => this.callbacks.onConnectionStatus(status),
      onSessionOpened: () => {
        this.currentUserTurnText = '';
        this.toolHandledCurrentTurn = false;
      },
      onLost: (reason) => {
        this.endConversation();
        this.callbacks.onMicWarning(reason);
      },
      shouldReconnect: () => this.conversationActive,
    });
  }

  public setCatalog(catalog: SongClip[]) {
    this.catalog = catalog;
  }

  private unlockAudioContext() {
    if (typeof window === 'undefined') return;
    try {
      if (!this.audioCtx) this.audioCtx = new AudioContext();
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch((err) => console.warn('[bumblebee] resume falló:', err));
      }
    } catch (err) {
      console.warn('[bumblebee] No se pudo crear el AudioContext:', err);
    }
  }

  /**
   * Plays a brief analog FM radio tuning sweep + white noise burst
   * before dropping into the real song clip, just like Bumblebee's car radio.
   */
  private async playFmTuningStatic(durationMs = 240): Promise<void> {
    if (typeof window === 'undefined') return;
    this.unlockAudioContext();
    const ctx = this.audioCtx;
    if (!ctx) return;

    return new Promise((resolve) => {
      try {
        const durSec = durationMs / 1000;
        const bufferSize = Math.floor(ctx.sampleRate * durSec);
        const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
          output[i] = (Math.random() * 2 - 1) * 0.22;
        }

        const whiteNoise = ctx.createBufferSource();
        whiteNoise.buffer = noiseBuffer;

        const bandpass = ctx.createBiquadFilter();
        bandpass.type = 'bandpass';
        bandpass.frequency.setValueAtTime(900, ctx.currentTime);
        bandpass.frequency.exponentialRampToValueAtTime(2600, ctx.currentTime + durSec);
        bandpass.Q.value = 3.2;

        const osc = ctx.createOscillator();
        const oscGain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1400, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(520, ctx.currentTime + durSec);
        oscGain.gain.setValueAtTime(0.05, ctx.currentTime);
        oscGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durSec);

        const masterGain = ctx.createGain();
        masterGain.gain.setValueAtTime(0.28, ctx.currentTime);
        masterGain.gain.exponentialRampToValueAtTime(0.02, ctx.currentTime + durSec);

        whiteNoise.connect(bandpass);
        bandpass.connect(masterGain);
        osc.connect(oscGain);
        oscGain.connect(masterGain);
        masterGain.connect(ctx.destination);

        whiteNoise.start();
        osc.start();
        whiteNoise.stop(ctx.currentTime + durSec);
        osc.stop(ctx.currentTime + durSec);

        setTimeout(resolve, durationMs);
      } catch (err) {
        console.warn('[bumblebee] No se pudo reproducir el barrido FM:', err);
        resolve();
      }
    });
  }

  /** "Cortar": stops the clip, resolves the pending clip promise and leaves the dial idle. */
  public stopCurrentPlayback() {
    this.playSeq += 1;
    if (this.clipTimer) {
      clearTimeout(this.clipTimer);
      this.clipTimer = null;
    }
    if (this.currentAudioEl) {
      const audio = this.currentAudioEl;
      this.currentAudioEl = null;
      audio.onended = null;
      audio.onerror = null;
      audio.onplaying = null;
      try {
        audio.pause();
      } catch (err) {
        console.warn('[bumblebee] pause falló:', err);
      }
    }
    const finish = this.finishCurrentClip;
    this.finishCurrentClip = null;
    finish?.();
    const wasPlaying = this.isPlayingRadio;
    this.isPlayingRadio = false;
    this.callbacks.onPlaybackStatus('idle');
    this.callbacks.onNowPlaying(null, IDLE_FREQUENCY, '');
    if (wasPlaying) {
      void this.hudClient.updateHud({ speaking: false, listening: this.conversationActive });
    }
  }

  /**
   * Executes a 6-DOF arm dance AND a Mecanum chassis movement, so every segment
   * visibly moves the robot. Resolves with the arm gesture result.
   */
  private async triggerPhysicalDanceStep(gestureName: string): Promise<RobotActionResult> {
    this.danceStepCounter += 1;
    const effectiveGesture =
      pickEnum(gestureName, BUMBLEBEE_DANCES) ??
      BUMBLEBEE_DANCES[this.danceStepCounter % BUMBLEBEE_DANCES.length];

    const dir = this.danceStepCounter % 2 === 0 ? 1 : -1;
    const [gesture, chassis] = await Promise.all([
      this.bridge.triggerGesture(effectiveGesture, 'dancing'),
      this.bridge.moveChassis(0.05 * dir, 0.14 * dir, 0.35 * dir, 520),
    ]);
    if (!gesture.ok) console.warn('[bumblebee] Baile del brazo falló:', gesture.code, gesture.message);
    if (!chassis.ok) console.warn('[bumblebee] Movimiento del chasis falló:', chassis.code, chassis.message);
    return gesture.ok ? chassis : gesture;
  }

  private playOneClip(clip: SongClip, seq: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const audio = new Audio(clip.audioUrl);
      this.currentAudioEl = audio;
      const finish = () => {
        if (settled) return;
        settled = true;
        audio.onended = null;
        audio.onerror = null;
        audio.onplaying = null;
        if (this.finishCurrentClip === finish) this.finishCurrentClip = null;
        resolve();
      };
      this.finishCurrentClip = finish;

      let fallbackStarted = false;
      const fallbackOnMissingMp3 = (err?: unknown) => {
        // Both `error` and the play() rejection fire for a missing file: handle it once.
        if (settled || fallbackStarted || seq !== this.playSeq) return;
        fallbackStarted = true;
        audio.onended = null;
        audio.onerror = null;
        console.warn(
          `[bumblebee] Clip no disponible (${clip.audioUrl}); se reproduce un barrido de radio.`,
          err ?? audio.error?.message ?? ''
        );
        this.callbacks.onClipUnavailable(clip);
        // Keep the lyric on the dial roughly as long as the real clip would last.
        const holdMs = Math.round(Math.min(10, Math.max(1.6, clip.duration || 2)) * 1000);
        void this.playFmTuningStatic(Math.min(holdMs, 1400));
        this.clipTimer = setTimeout(() => {
          this.clipTimer = null;
          finish();
        }, holdMs);
      };
      audio.onplaying = () => this.callbacks.onClipUnavailable(null);
      audio.onended = finish;
      audio.onerror = () => fallbackOnMissingMp3();
      audio.play().catch(fallbackOnMissingMp3);
    });
  }

  /**
   * Plays a sequence of 1 or 2 MP3 clips from `/songs/clips/*.mp3` while dancing.
   * `firstStep` resolves with the robot result of the first dance step.
   */
  private startClipSequence(
    clips: SongClip[],
    gestureName?: string,
    caption = 'Sintonizando respuesta musical...',
    userPromptText = ''
  ): { firstStep: Promise<RobotActionResult>; done: Promise<void> } {
    let resolveFirst: (r: RobotActionResult) => void = () => {};
    const firstStep = new Promise<RobotActionResult>((r) => {
      resolveFirst = r;
    });
    if (!clips.length) {
      resolveFirst({ ok: false, target: 'simulator', message: 'No hay clips para reproducir.' });
      return { firstStep, done: Promise.resolve() };
    }

    this.stopCurrentPlayback();
    const seq = ++this.playSeq;
    this.isPlayingRadio = true;
    this.motionSuppressUntil = Date.now() + 1200;

    const chosenGesture = gestureName || clips[0].gesture || 'bumblebee_hype';
    const freq = `${(88.1 + ((clips[0].id.length * 3.7) % 19.6)).toFixed(1)} FM`;

    this.callbacks.onPlaybackStatus('tuning');
    this.callbacks.onNowPlaying(clips[0], freq, caption);
    this.callbacks.onTurnLog({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toLocaleTimeString(),
      userText: userPromptText || 'Conversación en vivo',
      clips,
      gesture: chosenGesture,
      caption,
    });

    const done = (async () => {
      await this.playFmTuningStatic(220);
      for (let i = 0; i < clips.length; i++) {
        if (seq !== this.playSeq) break;
        const clip = clips[i];
        if (i > 0) {
          await this.playFmTuningStatic(140);
          if (seq !== this.playSeq) break;
        }

        const segmentGesture =
          i === 0
            ? chosenGesture
            : clip.gesture || BUMBLEBEE_DANCES[(this.danceStepCounter + i) % BUMBLEBEE_DANCES.length];
        const step = this.triggerPhysicalDanceStep(segmentGesture);
        if (i === 0) void step.then(resolveFirst);

        const clipFreq = `${(88.5 + ((clip.title.length * 2.9 + i * 4.3) % 19.2)).toFixed(1)} FM`;
        this.callbacks.onPlaybackStatus('playing');
        this.callbacks.onNowPlaying(clip, clipFreq, caption);
        void this.hudClient.updateHud({
          speaking: true,
          listening: false,
          headline: `🎵 ${clip.lyrics}`,
          subtext: `${clip.title} · ${clip.artist} (${clipFreq})`,
          mood: segmentGesture,
        });

        await this.playOneClip(clip, seq);
        this.motionSuppressUntil = Date.now() + 500;
      }

      resolveFirst({ ok: false, target: 'simulator', message: 'La secuencia se cortó antes de bailar.' });
      if (seq !== this.playSeq) return; // cut or superseded: stopCurrentPlayback already updated the UI

      this.currentAudioEl = null;
      this.isPlayingRadio = false;
      this.callbacks.onPlaybackStatus('idle');
      this.callbacks.onNowPlaying(null, IDLE_FREQUENCY, 'Sintonizador listo — sigue hablándole');
      void this.hudClient.updateHud({
        speaking: false,
        listening: this.conversationActive,
        headline: this.conversationActive ? 'RADIO BUMBLEBEE ESCUCHANDO' : 'RADIO EN ESPERA',
        subtext: 'Háblale en español o inglés y responderá con canciones',
        mood: 'attentive',
      });
    })();

    return { firstStep, done };
  }

  public async playClipSequence(
    clips: SongClip[],
    gestureName?: string,
    caption?: string,
    userPromptText = ''
  ): Promise<void> {
    await this.startClipSequence(clips, gestureName, caption, userPromptText).done;
  }

  public matchSongsForPrompt(userText: string): SongMatch {
    return matchSongsForPrompt(this.catalog, userText, this.matchState);
  }

  public async respondWithMusic(userText: string): Promise<void> {
    const clean = userText.trim();
    if (!clean) return;
    this.unlockAudioContext();
    this.callbacks.onUserTranscript(clean);
    const matched = this.matchSongsForPrompt(clean);
    await this.playClipSequence(matched.clips, matched.gesture, matched.caption, clean);
  }

  private buildSystemPrompt(): string {
    const byRole: Record<string, SongClip[]> = {};
    for (const c of this.catalog) {
      const r = c.role || 'state';
      if (!byRole[r]) byRole[r] = [];
      byRole[r].push(c);
    }

    const roleOrder = [
      'greet',
      'farewell',
      'affirm',
      'deny',
      'ask',
      'encourage',
      'comfort',
      'celebrate',
      'joke',
      'thank',
      'apologize',
      'state',
      'ponder',
      'react',
      'challenge',
      'love',
    ];

    const sections: string[] = [];
    for (const role of roleOrder) {
      const list = byRole[role];
      if (!list || !list.length) continue;
      sections.push(
        `=== ${role.toUpperCase()} ===\n` +
          list
            .map(
              (c) =>
                `  ${c.id} [${c.lang.toUpperCase()}] FULL LYRIC: "${c.lyrics}" -> ${c.meanings.join(', ')}`
            )
            .join('\n')
      );
    }

    return `You are Bumblebee onboard the physical Hiwonder ROSOrin Pro robot.
Your voice box is damaged: YOU CANNOT SPEAK WITH YOUR OWN VOICE. You communicate ONLY by calling \`play_radio_sequence\`.

CRITICAL RULES FOR SELECTING SONG CLIPS:
1. DEFAULT TO A SINGLE CLIP (1 clip in \`clip_ids\`): Pick the single clip whose COMPLETE SUNG LYRIC is the wittiest, clearest direct answer to what the user said.
2. ONLY USE 2 CLIPS IF THEY FORM ONE COHERENT SENTENCE TOGETHER: Never combine two clips unless Lyric 1 + Lyric 2 read as a natural, logical two-part sentence. If 1 clip says it all, ONLY pass 1 clip!
3. EXAMPLES OF GREAT SINGLE-CLIP ANSWERS:
   - "Se cayó producción y nadie sabe por qué" -> \`["en_anti_hero"]\` ("It's me, hi, I'm the problem, it's me") or \`["en_under_pressure"]\` or \`["en_another_one_bites_the_dust"]\`.
   - "¿Qué opinas de la inteligencia artificial?" -> \`["en_bohemian_rhapsody"]\` ("Is this the real life? Is this just fantasy?") or \`["es_te_felicito"]\`.
   - "¿Me vas a dejar solo arreglando este bug a las 3 AM?" -> \`["en_never_gonna_give_you_up"]\` or \`["en_lean_on_me"]\`.
   - "Baila con las llantas Mecanum" -> \`["es_danza_kuduro"]\` or \`["es_la_bamba"]\`.
4. Always pick an expressive \`dance_gesture\` (\`bumblebee_hype\`, \`bumblebee_groove\`, \`bumblebee_rock_out\`, \`bumblebee_romance\`, \`bumblebee_sad_droop\`, \`bumblebee_sassy\`).
5. NEVER generate spoken words of your own; ONLY respond via \`play_radio_sequence\`.
6. Use only clip IDs that appear in the catalog below.

CATALOG BY CONVERSATIONAL ROLE:
${sections.join('\n')}`;
  }

  private handleMessage(msg: LiveServerMessage) {
    // Model audio is ignored on purpose: Bumblebee only "speaks" through song clips.
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }

    const inText = msg.serverContent?.inputTranscription?.text;
    if (inText && !this.isPlayingRadio) {
      const validPiece = sanitizeTranscriptChunk(inText);
      if (validPiece) {
        this.currentUserTurnText = `${this.currentUserTurnText}${validPiece}`.replace(/\s+/g, ' ').trim();
        if (this.currentUserTurnText.length >= 2) {
          this.callbacks.onUserTranscript(this.currentUserTurnText);
        }

        if (this.silenceDebounceTimer) clearTimeout(this.silenceDebounceTimer);
        const capturedText = this.currentUserTurnText;
        this.silenceDebounceTimer = setTimeout(() => {
          if (!this.toolHandledCurrentTurn && !this.isPlayingRadio && capturedText.trim().length >= 3) {
            this.toolHandledCurrentTurn = true;
            this.currentUserTurnText = '';
            void this.respondWithMusic(capturedText);
          }
        }, 1450);
      }
    }

    if (msg.toolCall?.functionCalls?.length) {
      void this.handleToolCalls(msg.toolCall.functionCalls);
    }

    if (msg.toolCallCancellation?.ids?.length) {
      console.info('[bumblebee] El servidor canceló tool calls:', msg.toolCallCancellation.ids);
    }

    if (msg.serverContent?.turnComplete) {
      if (!this.toolHandledCurrentTurn && !this.isPlayingRadio && this.currentUserTurnText.trim().length >= 2) {
        const pendingText = this.currentUserTurnText.trim();
        this.toolHandledCurrentTurn = true;
        this.currentUserTurnText = '';
        void this.respondWithMusic(pendingText);
      } else {
        this.toolHandledCurrentTurn = false;
        this.currentUserTurnText = '';
      }
    }
  }

  private async handleToolCalls(calls: FunctionCall[]) {
    if (this.silenceDebounceTimer) clearTimeout(this.silenceDebounceTimer);
    const alreadyHandled = this.toolHandledCurrentTurn || this.isPlayingRadio;
    this.toolHandledCurrentTurn = true;
    const userSpoken = this.currentUserTurnText || 'Conversación por micrófono';
    this.currentUserTurnText = '';

    const responses: FunctionResponse[] = [];
    for (const fc of calls) {
      let response: Record<string, unknown>;
      if (fc.name !== 'play_radio_sequence') {
        response = { status: 'error', message: `Herramienta desconocida: ${fc.name}.` };
      } else if (alreadyHandled) {
        response = {
          status: 'ok',
          message: 'This turn was already answered with a clip chosen locally; nothing else was played.',
        };
      } else {
        const args = fc.args ?? {};
        const requestedIds = cleanIdList(args.clip_ids, 2);
        const resolvedClips = requestedIds
          .map((id) => this.catalog.find((c) => c.id === id))
          .filter((c): c is SongClip => Boolean(c))
          .slice(0, 2);
        let played: SongClip[];
        let firstStep: Promise<RobotActionResult>;
        let note = '';
        if (resolvedClips.length > 0) {
          played = resolvedClips;
          const dance = pickEnum(args.dance_gesture, BUMBLEBEE_DANCES) ?? resolvedClips[0].gesture;
          const caption = cleanToolText(args.radio_caption, 80) || `Sintonizando "${resolvedClips[0].title}"`;
          ({ firstStep } = this.startClipSequence(resolvedClips, dance, caption, userSpoken));
        } else {
          const match = this.matchSongsForPrompt(userSpoken);
          played = match.clips;
          note = ` Requested ids not in the catalog (${requestedIds.join(', ') || 'none'}); the local matcher picked the clip.`;
          ({ firstStep } = this.startClipSequence(match.clips, match.gesture, match.caption, userSpoken));
        }
        const dance = await firstStep;
        response = dance.ok
          ? { status: 'ok', clips_played: played.map((c) => c.id), target: dance.target, message: `Playing.${note}` }
          : {
              status: 'error',
              code: dance.code ?? 'dance_failed',
              clips_played: played.map((c) => c.id),
              message: `The music plays but the robot could not dance: ${dance.message}${note}`,
            };
      }
      responses.push({ id: fc.id, name: fc.name, response });
    }
    this.live.sendToolResponse({ functionResponses: responses });
  }

  /**
   * Starts a hands-free Bumblebee Radio conversation: Gemini Live first, then the mic.
   * Without an API key it does not open the mic (quick prompts and text still work).
   */
  public async startRadioConversation(): Promise<boolean> {
    stopAllActiveConversations('navigation');
    if (activeBumblebeeSession && activeBumblebeeSession !== this) {
      activeBumblebeeSession.stopRadioConversation('navigation');
    }
    setActiveBumblebeeSession(this);
    this.unlockAudioContext();

    const key = getEffectiveApiKey();
    if (!key) {
      this.callbacks.onConnectionStatus('no_key');
      this.callbacks.onMicWarning(NO_KEY_WARNING);
      return false;
    }

    this.conversationActive = true;
    const connected = await this.live.ensure(key);
    if (!this.conversationActive) return false;
    if (!connected) {
      this.conversationActive = false;
      this.callbacks.onMicWarning(CONNECT_FAILED_WARNING);
      return false;
    }

    const res = await this.mic.start((frame, sampleRate) => this.onMicFrame(frame, sampleRate));
    if (!this.conversationActive) {
      this.mic.stop();
      return false;
    }
    if (res === 'ok') {
      this.callbacks.onMicWarning(null);
      this.callbacks.onConversationActiveChange(true);
      void this.hudClient.updateHud({
        speaking: false,
        listening: true,
        headline: 'RADIO BUMBLEBEE ACTIVA',
        subtext: 'Háblale y responderá bailando con fragmentos de canciones',
        mood: 'attentive',
      });
    } else if (res === 'unsupported') {
      this.callbacks.onMicWarning(
        'Micrófono bloqueado por HTTP sobre IP. Usa las frases rápidas, escribe abajo o abre http://localhost:3000/demos/bumblebee en tu laptop.'
      );
    } else if (res === 'denied') {
      this.callbacks.onMicWarning(
        'No se pudo abrir el micrófono. Puedes conversar escribiendo o usando las frases rápidas.'
      );
    }
    return true;
  }

  private onMicFrame(frame: PcmWorkletFrame, sampleRate: number) {
    if (!this.conversationActive) return;
    const normalizedLevel = Math.min(1, frame.rms * 8);
    this.callbacks.onMicLevelChange(normalizedLevel);
    if (!this.live.isOpen) return;

    const isMuted =
      this.isPlayingRadio || Date.now() < this.motionSuppressUntil || normalizedLevel < 0.09;
    const pcm16 = isMuted
      ? new Int16Array(Math.round((frame.samples.length * 16000) / sampleRate))
      : downsampleFloat32ToInt16_16kHz(frame.samples, sampleRate);

    this.live.sendRealtimeInput({
      audio: { mimeType: 'audio/pcm;rate=16000', data: int16ToBase64(pcm16) },
    });
  }

  private endConversation() {
    this.conversationActive = false;
    if (this.silenceDebounceTimer) clearTimeout(this.silenceDebounceTimer);
    this.silenceDebounceTimer = null;
    this.mic.stop();
    this.callbacks.onConversationActiveChange(false);
    this.callbacks.onMicLevelChange(0);
  }

  public stopRadioConversation(reason: StopReason = 'user') {
    const wasActive = this.conversationActive || this.mic.active || this.live.isOpen;
    this.endConversation();
    this.live.close();
    this.stopCurrentPlayback();
    this.callbacks.onConnectionStatus('idle');
    void this.hudClient.updateHud({ speaking: false, listening: false });
    if (reason === 'tab_hidden' && wasActive) this.callbacks.onMicWarning(TAB_HIDDEN_WARNING);
    if (activeBumblebeeSession === this) activeBumblebeeSession = null;
  }

  /** Releases everything, including the AudioContext used for the FM sweep (page unmount). */
  public dispose() {
    this.stopRadioConversation('unmount');
    if (this.audioCtx) {
      const ctx = this.audioCtx;
      this.audioCtx = null;
      ctx.close().catch((err) => console.warn('[bumblebee] close falló:', err));
    }
  }
}
