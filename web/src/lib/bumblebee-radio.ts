import { GoogleGenAI, Modality, Type, type FunctionDeclaration } from '@google/genai';
import { RobotBridgeClient } from './robot-client';
import { stopAllActiveConversations, type RobotActionHandler } from './gemini-live';
import {
  attachPcmCaptureWorklet,
  downsampleFloat32ToInt16_16kHz,
  int16ToBase64,
} from './audio-worklet';

export interface SongClip {
  id: string;
  lang: 'en' | 'es';
  title: string;
  artist: string;
  lyrics: string;
  mood: string;
  role: string;
  meanings: string[];
  duration: number;
  audioUrl: string;
  gesture: string;
  embedding?: number[];
}

export interface RadioTurnLog {
  id: string;
  timestamp: string;
  userText: string;
  clips: SongClip[];
  gesture: string;
  caption: string;
}

export interface BumblebeeCallbacks {
  onStatus: (status: 'idle' | 'connecting' | 'live' | 'tuning' | 'playing') => void;
  onConversationActiveChange: (active: boolean) => void;
  onUserTranscript: (text: string) => void;
  onNowPlaying: (clip: SongClip | null, frequencyMhz: string, caption: string) => void;
  onTurnLog: (turn: RadioTurnLog) => void;
  onMicLevelChange: (level: number) => void;
  onMicWarning: (warning: string | null) => void;
}

const BUMBLEBEE_DANCES = [
  'bumblebee_hype',
  'bumblebee_groove',
  'bumblebee_rock_out',
  'bumblebee_romance',
  'bumblebee_sad_droop',
  'bumblebee_sassy',
] as const;

export const BUMBLEBEE_TOOLS: FunctionDeclaration[] = [
  {
    name: 'play_radio_sequence',
    description:
      'Respond to the user exclusively by tuning the FM radio to play 1 to 3 real song clips (in Spanish or English) from the catalog while dancing with the 6-DOF robotic arm and Mecanum chassis.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        clip_ids: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: '1 to 3 song clip IDs from the catalog whose complete lyrics form your response.',
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

// Same 24 semantic concept axes + 8 char-trigram buckets used when indexing catalog.json
const SEMANTIC_AXES: string[][] = [
  ['hola', 'hello', 'hey', 'greet', 'greeting', 'welcome', 'buenas', 'saludo', 'qué onda', 'que onda', 'arrival', 'entrance'],
  ['adiós', 'adios', 'bye', 'farewell', 'goodbye', 'me voy', 'despedida', 'hasta luego', 'nos vemos', 'leave', 'leaving'],
  ['sí', 'si', 'yes', 'affirm', 'claro', 'exacto', 'aprobado', 'agree', 'confirm', 'correct', 'true', 'dale'],
  ['no', 'deny', 'never', 'jamás', 'jamas', 'rechazado', 'refuse', 'disagree', 'stop', 'warning', 'falso'],
  ['pregunta', 'ask', 'question', 'qué', 'que', 'cómo', 'como', 'por qué', 'por que', 'dime', 'cuéntame', 'cuentame', 'curious', 'what', 'why', 'how'],
  ['ánimo', 'animo', 'encourage', 'fuerza', 'tú puedes', 'tu puedes', 'vamos', 'adelante', 'strong', 'survive', 'keep_going', 'power'],
  ['triste', 'sad', 'comfort', 'mal día', 'mal dia', 'llorar', 'dolor', 'hurt', 'empathy', 'broken', 'consolation', 'cry'],
  ['fiesta', 'party', 'celebrate', 'bailar', 'baila', 'dance', 'romperla', 'escenario', 'jsconf', 'hype', 'happy', 'feliz', 'alegría', 'alegria', 'fun'],
  ['chiste', 'joke', 'funny', 'risa', 'jaja', 'humor', 'loco', 'crazy', 'absurd', 'troll', 'laugh', 'silly'],
  ['gracias', 'thank', 'thanks', 'agradecido', 'gratitude', 'appreciate', 'friend', 'amigo'],
  ['perdón', 'perdon', 'sorry', 'apologize', 'disculpa', 'culpa', 'error', 'oops', 'regret', 'mistake', 'equivoqué', 'equivoque'],
  ['estado', 'state', 'cómo estás', 'como estas', 'bien', 'genial', 'levitating', 'viviendo', 'feeling', 'good', 'great'],
  ['pensar', 'ponder', 'think', 'duda', 'quizás', 'quizas', 'realidad', 'fantasía', 'fantasia', 'philosophy', 'wonder', 'maybe'],
  ['sorpresa', 'react', 'wow', 'increíble', 'increible', 'shock', 'fuego', 'fire', 'boom', 'intense', 'thunder'],
  ['reto', 'challenge', 'pelea', 'poder', 'jefe', 'bichota', 'boss', 'rebel', 'fight', 'champion', 'ganar', 'win'],
  ['amor', 'love', 'quiero', 'te amo', 'corazón', 'corazon', 'guapo', 'lindo', 'beso', 'romance', 'crush', 'sweet', 'bb', 'bebé', 'bebe'],
  ['bug', 'producción', 'produccion', 'cayó', 'cayo', 'incidente', 'server', 'servidor', 'crash', 'down', 'pressure', 'emergency', 'caos'],
  ['deploy', 'ci/cd', 'pr', 'pull request', 'verde', 'tests', 'campeón', 'campeon', 'victoria', 'success', 'ship', 'launch'],
  ['clima', 'weather', 'sol', 'sun', 'sunshine', 'lluvia', 'rain', 'calor', 'frío', 'frio', 'día', 'dia'],
  ['ia', 'ai', 'inteligencia artificial', 'robot', 'futuro', 'future', 'tecnología', 'tecnologia', 'machine', 'code', 'código', 'codigo'],
  ['música', 'musica', 'reggaeton', 'rock', 'pop', 'salsa', 'cumbia', 'canción', 'cancion', 'radio', 'ritmo', 'beat'],
  ['rápido', 'rapido', 'fast', 'velocidad', 'speed', 'gasolina', 'energía', 'energia', 'turbo', 'rush'],
  ['calma', 'calm', 'tranquilo', 'relax', 'suave', 'despacito', 'slow', 'chill', 'paz', 'ligera'],
  ['noche', 'night', 'after', 'oscuro', 'luces', 'lights', 'blinding', 'estrellas', 'party_night'],
];

function simpleHashBucket(tri: string): number {
  let h = 2166136261;
  for (let i = 0; i < tri.length; i++) {
    h ^= tri.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 8;
}

export function embedQueryVector(queryText: string): number[] {
  const combined = queryText.toLowerCase();
  const vec: number[] = [];
  for (const axisWords of SEMANTIC_AXES) {
    let score = 0;
    for (const w of axisWords) {
      if (combined.includes(w)) {
        score += 1.0;
      }
    }
    vec.push(score);
  }
  const buckets = [0, 0, 0, 0, 0, 0, 0, 0];
  const clean = combined.replace(/[^a-z0-9áéíóúüñ]/g, '');
  for (let i = 0; i < Math.max(0, clean.length - 2); i++) {
    const tri = clean.slice(i, i + 3);
    buckets[simpleHashBucket(tri)] += 0.25;
  }
  vec.push(...buckets);
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1.0;
  return vec.map((v) => v / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

const NON_LATIN_SCRIPT_REGEX =
  /[\u0370-\u03FF\u0400-\u04FF\u0500-\u052F\u0530-\u058F\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0900-\u0DFF\u0E00-\u0E7F\u1000-\u109F\u1100-\u11FF\u3000-\u9FFF\uAC00-\uD7AF]/;

function sanitizeTranscriptChunk(raw: string): string {
  if (NON_LATIN_SCRIPT_REGEX.test(raw)) return '';
  return raw.replace(/[^\u0020-\u007E\u00A0-\u024F\u2010-\u2027¿¡]/g, '');
}

let activeBumblebeeSession: BumblebeeRadioSession | null = null;

export function stopActiveBumblebeeSession() {
  if (activeBumblebeeSession) {
    activeBumblebeeSession.stopRadioConversation();
    activeBumblebeeSession = null;
  }
}

export class BumblebeeRadioSession {
  private bridge: RobotActionHandler;
  private hudClient: RobotBridgeClient;
  private callbacks: BumblebeeCallbacks;
  private catalog: SongClip[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private session: any = null;
  private audioCtx: AudioContext | null = null;
  private currentAudioEl: HTMLAudioElement | null = null;
  private isPlayingRadio = false;
  private motionSuppressUntil = 0;
  private conversationActive = false;
  private micStream: MediaStream | null = null;
  private micAudioCtx: AudioContext | null = null;
  private micWorkletCleanup: (() => void) | null = null;
  private currentUserTurnText = '';
  private silenceDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private toolHandledCurrentTurn = false;
  private recentClipIds: string[] = [];
  private danceStepCounter = 0;

  constructor(
    bridge: RobotActionHandler | undefined | null,
    callbacks: BumblebeeCallbacks,
    catalog: SongClip[] = []
  ) {
    this.bridge = bridge || new RobotBridgeClient();
    this.hudClient = new RobotBridgeClient();
    this.callbacks = callbacks;
    this.catalog = catalog;
  }

  public setCatalog(catalog: SongClip[]) {
    this.catalog = catalog;
  }

  public updateBridge(bridge: RobotActionHandler) {
    this.bridge = bridge;
  }

  public getEffectiveApiKey(): string {
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem('rosorin_gemini_api_key');
      if (stored && stored.trim()) return stored.trim();
    }
    if (process.env.NEXT_PUBLIC_GEMINI_API_KEY) {
      return process.env.NEXT_PUBLIC_GEMINI_API_KEY.trim();
    }
    return '';
  }

  private unlockAudioContext() {
    if (typeof window === 'undefined') return;
    try {
      if (!this.audioCtx) {
        this.audioCtx = new AudioContext();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }
    } catch {
      // ignore
    }
  }

  /**
   * Plays a brief analog FM radio tuning sweep + white noise burst (240 ms)
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
      } catch {
        resolve();
      }
    });
  }

  public stopCurrentPlayback() {
    if (this.currentAudioEl) {
      try {
        this.currentAudioEl.pause();
        this.currentAudioEl.currentTime = 0;
      } catch {
        // ignore
      }
      this.currentAudioEl = null;
    }
    this.isPlayingRadio = false;
    this.callbacks.onNowPlaying(null, '104.7 FM', '');
    this.hudClient.updateHud({ speaking: false, listening: this.conversationActive });
  }

  /**
   * Executes both a 6-DOF arm dance choreography AND a Mecanum chassis movement
   * so that every single time Bumblebee responds or switches segments, the robot visibly moves!
   */
  private triggerPhysicalDanceStep(gestureName: string) {
    this.danceStepCounter += 1;
    const altGestures = [...BUMBLEBEE_DANCES];
    const effectiveGesture =
      BUMBLEBEE_DANCES.includes(gestureName as (typeof BUMBLEBEE_DANCES)[number])
        ? gestureName
        : altGestures[this.danceStepCounter % altGestures.length];

    this.bridge.triggerGesture(effectiveGesture, 'dancing').catch(() => {});

    // Also trigger a rhythmic Mecanum chassis movement (strafe/spin)
    const dir = this.danceStepCounter % 2 === 0 ? 1 : -1;
    this.bridge.moveChassis(0.05 * dir, 0.14 * dir, 0.35 * dir, 520).catch(() => {});
  }

  /**
   * Plays a sequence of 1 to 3 real MP3 clips from `/songs/clips/*.mp3`
   * while executing physical Bumblebee dances on every segment and updating `/face`.
   */
  public async playClipSequence(
    clips: SongClip[],
    gestureName?: string,
    caption = 'Sintonizando respuesta musical...',
    userPromptText = ''
  ): Promise<void> {
    if (!clips.length) return;
    this.stopCurrentPlayback();
    this.isPlayingRadio = true;
    this.motionSuppressUntil = Date.now() + 1200;

    const chosenGesture = gestureName || clips[0].gesture || 'bumblebee_hype';
    const freq = `${(88.1 + ((clips[0].id.length * 3.7) % 19.6)).toFixed(1)} FM`;

    this.callbacks.onStatus('tuning');
    this.callbacks.onNowPlaying(clips[0], freq, caption);

    // 1. Log the turn in the UI
    this.callbacks.onTurnLog({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toLocaleTimeString(),
      userText: userPromptText || 'Conversación en vivo',
      clips,
      gesture: chosenGesture,
      caption,
    });

    // 2. Play short FM radio tuning static
    await this.playFmTuningStatic(220);

    // 3. Play each clip sequentially while triggering a physical dance + Mecanum move per segment
    for (let i = 0; i < clips.length; i++) {
      if (!this.isPlayingRadio) break;
      const clip = clips[i];
      if (i > 0) {
        await this.playFmTuningStatic(140);
      }

      // Guarantee a visible gesture + movement on EVERY segment
      const segmentGesture =
        i === 0
          ? chosenGesture
          : clip.gesture || BUMBLEBEE_DANCES[(this.danceStepCounter + i) % BUMBLEBEE_DANCES.length];
      this.triggerPhysicalDanceStep(segmentGesture);

      const clipFreq = `${(88.5 + ((clip.title.length * 2.9 + i * 4.3) % 19.2)).toFixed(1)} FM`;
      this.callbacks.onStatus('playing');
      this.callbacks.onNowPlaying(clip, clipFreq, caption);

      this.hudClient.updateHud({
        speaking: true,
        listening: false,
        headline: `🎵 ${clip.lyrics}`,
        subtext: `${clip.title} · ${clip.artist} (${clipFreq})`,
        mood: segmentGesture,
      });

      await new Promise<void>((resolve) => {
        const audio = new Audio(clip.audioUrl);
        this.currentAudioEl = audio;
        const done = () => {
          audio.onended = null;
          audio.onerror = null;
          resolve();
        };
        audio.onended = done;
        audio.onerror = done;
        audio.play().catch(done);
      });

      this.motionSuppressUntil = Date.now() + 500;
    }

    this.currentAudioEl = null;
    this.isPlayingRadio = false;
    this.callbacks.onStatus(this.conversationActive ? 'live' : 'idle');
    this.callbacks.onNowPlaying(null, '104.7 FM', 'Sintonizador listo — sigue hablándole');
    this.hudClient.updateHud({
      speaking: false,
      listening: this.conversationActive,
      headline: this.conversationActive ? 'RADIO BUMBLEBEE ESCUCHANDO' : 'RADIO EN ESPERA',
      subtext: 'Háblale en español o inglés y responderá con canciones',
      mood: 'attentive',
    });
  }

  /**
   * Embedding + Conversational Role Composer:
   * Uses the 32-dim semantic embeddings in `catalog.json` to score all 171 song segments
   * in <2ms and stitches 1–2 complementary segments into a complete musical answer.
   */
  public matchSongsForPrompt(userText: string): {
    clips: SongClip[];
    gesture: string;
    caption: string;
  } {
    if (!this.catalog.length) {
      return { clips: [], gesture: 'bumblebee_groove', caption: 'Catálogo vacío' };
    }

    const q = userText.toLowerCase();
    const queryVec = embedQueryVector(userText);
    const tokens = q
      .replace(/[^a-z0-9áéíóúüñ\s]/gi, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2);

    const pickById = (id: string) => this.catalog.find((c) => c.id === id);

    // 1. High-precision multi-segment conversational patterns (from pupper-bumblebee)
    if (
      q.includes('hola') ||
      q.includes('hello') ||
      q.includes('cómo estás') ||
      q.includes('como estas') ||
      q.includes('listo') ||
      q.includes('romperla') ||
      q.includes('escenario')
    ) {
      const greetPool = [
        pickById('en_hey_ya'),
        pickById('es_dakiti'),
        pickById('es_provenza_baby'),
        pickById('es_la_bamba'),
      ].filter(Boolean) as SongClip[];
      const statePool = [
        pickById('es_vivir_mi_vida'),
        pickById('en_levitating'),
        pickById('en_walking_on_sunshine'),
        pickById('es_bichota'),
      ].filter(Boolean) as SongClip[];

      const c1 = greetPool.find((c) => !this.recentClipIds.includes(c.id)) || greetPool[0];
      const c2 = statePool.find((c) => !this.recentClipIds.includes(c.id) && c.id !== c1?.id) || statePool[0];
      const chosenClips = [c1, c2].filter(Boolean) as SongClip[];
      this.recentClipIds = [...chosenClips.map((c) => c.id), ...this.recentClipIds].slice(0, 8);
      return {
        clips: chosenClips,
        gesture: 'bumblebee_hype',
        caption: '¡Saludo + estado de ánimo sintonizados en secuencia FM!',
      };
    }

    if (
      q.includes('cayó') ||
      q.includes('cayo') ||
      q.includes('bug') ||
      q.includes('error') ||
      q.includes('incidente') ||
      q.includes('producción') ||
      q.includes('produccion') ||
      q.includes('mal día') ||
      q.includes('mal dia')
    ) {
      const reactClip =
        pickById('en_under_pressure') ||
        pickById('en_anti_hero') ||
        pickById('es_lo_siento_bb');
      const encourageClip =
        pickById('en_stayin_alive') ||
        pickById('en_i_will_survive') ||
        pickById('es_vivir_mi_vida');
      const chosenClips = [reactClip, encourageClip].filter(Boolean) as SongClip[];
      this.recentClipIds = [...chosenClips.map((c) => c.id), ...this.recentClipIds].slice(0, 8);
      return {
        clips: chosenClips,
        gesture: 'bumblebee_sad_droop',
        caption: 'Emergencia en producción → ¡pero sobreviviremos!',
      };
    }

    if (
      q.includes('perfecto') ||
      q.includes('verde') ||
      q.includes('aprobado') ||
      q.includes('deploy') ||
      q.includes('campeón') ||
      q.includes('campeon') ||
      q.includes('ganamos')
    ) {
      const c1 = pickById('en_we_are_the_champions') || pickById('en_walking_on_sunshine');
      const c2 = pickById('es_bichota') || pickById('es_vivir_mi_vida');
      const chosenClips = [c1, c2].filter(Boolean) as SongClip[];
      this.recentClipIds = [...chosenClips.map((c) => c.id), ...this.recentClipIds].slice(0, 8);
      return {
        clips: chosenClips,
        gesture: 'bumblebee_rock_out',
        caption: '¡Himno de victoria en producción!',
      };
    }

    if (
      q.includes('amor') ||
      q.includes('quiero') ||
      q.includes('love') ||
      q.includes('mejor') ||
      q.includes('lindo') ||
      q.includes('corazón') ||
      q.includes('corazon')
    ) {
      const c1 = pickById('es_limon_y_sal') || pickById('es_beso') || pickById('en_careless_whisper');
      const c2 = pickById('en_youve_got_a_friend') || pickById('es_eres');
      const chosenClips = [c1, c2].filter(Boolean) as SongClip[];
      this.recentClipIds = [...chosenClips.map((c) => c.id), ...this.recentClipIds].slice(0, 8);
      return {
        clips: chosenClips,
        gesture: 'bumblebee_romance',
        caption: 'Frecuencia Romántica FM · Cariño robótico',
      };
    }

    if (
      q.includes('chiste') ||
      q.includes('risa') ||
      q.includes('joke') ||
      q.includes('bailar') ||
      q.includes('mecanum') ||
      q.includes('brazo')
    ) {
      const c1 = pickById('en_crazy_train') || pickById('es_bizcochito');
      const c2 = pickById('en_bad_guy') || pickById('es_gasolina');
      const chosenClips = [c1, c2].filter(Boolean) as SongClip[];
      this.recentClipIds = [...chosenClips.map((c) => c.id), ...this.recentClipIds].slice(0, 8);
      return {
        clips: chosenClips,
        gesture: 'bumblebee_sassy',
        caption: '¡Modo fiesta omnidireccional en 6 ejes!',
      };
    }

    // 2. Dense vector cosine similarity search across all 171 embedded segments
    const scored = this.catalog.map((clip) => {
      const clipVec =
        clip.embedding && clip.embedding.length > 0
          ? clip.embedding
          : embedQueryVector(`${clip.title} ${clip.artist} ${clip.lyrics} ${clip.role} ${clip.meanings.join(' ')}`);

      let sim = cosineSimilarity(queryVec, clipVec) * 10;

      // Exact token overlap boost
      const hay = `${clip.title} ${clip.artist} ${clip.lyrics} ${clip.role} ${clip.meanings.join(' ')}`.toLowerCase();
      for (const tok of tokens) {
        if (hay.includes(tok)) sim += 2.5;
      }

      // Novelty boost so Bumblebee doesn't repeat the same song clip
      if (!this.recentClipIds.includes(clip.id)) {
        sim += 1.8;
      } else {
        sim -= 3.0;
      }

      sim += Math.random() * 0.35;
      return { clip, score: sim };
    });

    scored.sort((a, b) => b.score - a.score);
    const first = scored[0]?.clip || this.catalog[0];
    // Pick a complementary second segment with a different conversational role if top score is strong
    const second = scored.find(
      (item) =>
        item.clip.id !== first.id &&
        item.clip.role !== first.role &&
        !this.recentClipIds.includes(item.clip.id)
    )?.clip;

    const chosenClips = second && scored[0].score > 3.2 ? [first, second] : [first];
    this.recentClipIds = [...chosenClips.map((c) => c.id), ...this.recentClipIds].slice(0, 8);

    return {
      clips: chosenClips,
      gesture: first.gesture || 'bumblebee_groove',
      caption: `Sintonizando ${chosenClips.map((c) => `"${c.title}"`).join(' → ')}`,
    };
  }

  public async respondWithMusic(userText: string): Promise<void> {
    const clean = userText.trim();
    if (!clean) return;
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
Your voice box is damaged: YOU CANNOT SPEAK WITH YOUR OWN VOICE. You communicate ONLY by calling \`play_radio_sequence\` with 1 to 3 song clip IDs whose COMPLETE LYRICS form your answer.

CRITICAL FULL LYRIC RULE:
- The audience hears EVERY WORD of the clip lyric.
- Combine 1 to 3 clips in sequence so Lyric 1 + Lyric 2 = your conversational response.
- For greetings ("Hola, ¿cómo estás?"), use [en_hey_ya, es_vivir_mi_vida] or [es_dakiti, en_levitating]. Do NOT use en_hello for a normal greeting unless asked "is it me you're looking for".
- Always pick an expressive \`dance_gesture\` (\`bumblebee_hype\`, \`bumblebee_groove\`, \`bumblebee_rock_out\`, \`bumblebee_romance\`, \`bumblebee_sad_droop\`, \`bumblebee_sassy\`).

CATALOG BY CONVERSATIONAL ROLE:
${sections.join('\n')}`;
  }

  private async ensureGeminiLiveSession(apiKey: string): Promise<boolean> {
    if (this.session) return true;
    try {
      this.callbacks.onStatus('connecting');
      const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
      const model = process.env.NEXT_PUBLIC_GEMINI_LIVE_MODEL || 'gemini-3.8-live';

      this.session = await ai.live.connect({
        model,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: { parts: [{ text: this.buildSystemPrompt() }] },
          speechConfig: {
            languageCode: 'es-US',
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } },
          },
          inputAudioTranscription: {},
          tools: [{ functionDeclarations: BUMBLEBEE_TOOLS }],
        },
        callbacks: {
          onopen: () => this.callbacks.onStatus('live'),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onmessage: async (msg: any) => {
            const inText = msg.serverContent?.inputTranscription?.text;
            if (inText && !this.isPlayingRadio) {
              const validPiece = sanitizeTranscriptChunk(inText);
              if (validPiece) {
                this.currentUserTurnText = `${this.currentUserTurnText}${validPiece}`
                  .replace(/\s+/g, ' ')
                  .trim();
                if (this.currentUserTurnText.length >= 2) {
                  this.callbacks.onUserTranscript(this.currentUserTurnText);
                }

                if (this.silenceDebounceTimer) clearTimeout(this.silenceDebounceTimer);
                const capturedText = this.currentUserTurnText;
                this.silenceDebounceTimer = setTimeout(() => {
                  if (
                    !this.toolHandledCurrentTurn &&
                    !this.isPlayingRadio &&
                    capturedText.trim().length >= 3
                  ) {
                    this.toolHandledCurrentTurn = true;
                    this.currentUserTurnText = '';
                    this.respondWithMusic(capturedText);
                  }
                }, 950);
              }
            }

            if (msg.toolCall?.functionCalls?.length) {
              if (this.silenceDebounceTimer) clearTimeout(this.silenceDebounceTimer);
              this.toolHandledCurrentTurn = true;
              const userSpoken = this.currentUserTurnText || 'Conversación por micrófono';
              this.currentUserTurnText = '';

              const responses = [];
              for (const fc of msg.toolCall.functionCalls) {
                if (fc.name === 'play_radio_sequence') {
                  const args = (fc.args || {}) as {
                    clip_ids?: string[];
                    dance_gesture?: string;
                    radio_caption?: string;
                  };
                  const requestedIds = Array.isArray(args.clip_ids) ? args.clip_ids : [];
                  const resolvedClips = requestedIds
                    .map((id) => this.catalog.find((c) => c.id === id))
                    .filter(Boolean) as SongClip[];

                  if (resolvedClips.length > 0) {
                    this.playClipSequence(
                      resolvedClips.slice(0, 3),
                      args.dance_gesture || resolvedClips[0].gesture,
                      args.radio_caption || `Sintonizando ${resolvedClips.map((c) => c.title).join(' + ')}`,
                      userSpoken
                    );
                  } else {
                    this.respondWithMusic(userSpoken);
                  }
                }
                responses.push({
                  id: fc.id,
                  name: fc.name,
                  response: { status: 'ok' },
                });
              }
              try {
                await this.session.sendToolResponse({ functionResponses: responses });
              } catch {
                // ignore
              }
            }

            if (msg.serverContent?.turnComplete) {
              this.toolHandledCurrentTurn = false;
              this.currentUserTurnText = '';
            }
          },
          onerror: () => {
            this.session = null;
            this.callbacks.onStatus('live');
          },
          onclose: () => {
            this.session = null;
          },
        },
      });
      this.callbacks.onStatus('live');
      return true;
    } catch {
      this.session = null;
      this.callbacks.onStatus('live');
      return false;
    }
  }

  /**
   * Starts a continuous hands-free Bumblebee Radio conversation with AudioWorkletNode.
   */
  public async startRadioConversation(): Promise<boolean> {
    stopAllActiveConversations();
    if (activeBumblebeeSession && activeBumblebeeSession !== this) {
      activeBumblebeeSession.stopRadioConversation();
    }
    activeBumblebeeSession = this;
    this.unlockAudioContext();

    this.conversationActive = true;
    this.callbacks.onConversationActiveChange(true);
    this.hudClient.updateHud({
      speaking: false,
      listening: true,
      headline: 'RADIO BUMBLEBEE ACTIVA',
      subtext: 'Háblale y responderá bailando con fragmentos de canciones',
      mood: 'attentive',
    });

    const key = this.getEffectiveApiKey();
    if (!key) {
      this.callbacks.onMicWarning(
        'No se encontró GEMINI_API_KEY en .env ni en el navegador. Configura tu API Key en la barra superior para activar micrófono con Gemini Live, o usa las frases y el buscador semántico abajo.'
      );
      this.callbacks.onStatus('live');
    } else {
      await this.ensureGeminiLiveSession(key);
    }

    if (typeof window === 'undefined') return false;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.callbacks.onMicWarning(
        'Micrófono bloqueado por HTTP sobre IP. Usa los disparadores rápidos, escribe abajo o abre http://localhost:3000/demos/bumblebee en tu laptop.'
      );
      return true;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      if (!this.conversationActive) {
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }

      if (key) {
        this.callbacks.onMicWarning(null);
      }
      this.micStream = stream;
      const micCtx = new AudioContext();
      if (micCtx.state === 'suspended') {
        await micCtx.resume().catch(() => {});
      }
      this.micAudioCtx = micCtx;

      const { disconnect } = await attachPcmCaptureWorklet(micCtx, stream, (frame) => {
        if (!this.conversationActive) return;
        const inputData = frame.samples;
        const rms = frame.rms;

        const normalizedLevel = Math.min(1, rms * 8);
        this.callbacks.onMicLevelChange(normalizedLevel);

        if (!this.session) return;

        const isMuted =
          this.isPlayingRadio ||
          Date.now() < this.motionSuppressUntil ||
          normalizedLevel < 0.09;

        let pcm16: Int16Array;
        if (isMuted) {
          const outLen = Math.round((inputData.length * 16000) / micCtx.sampleRate);
          pcm16 = new Int16Array(outLen);
        } else {
          pcm16 = downsampleFloat32ToInt16_16kHz(inputData, micCtx.sampleRate);
        }

        const base64Pcm = int16ToBase64(pcm16);

        try {
          this.session.sendRealtimeInput({
            media: {
              mimeType: 'audio/pcm;rate=16000',
              data: base64Pcm,
            },
          });
        } catch {
          // ignore
        }
      });

      this.micWorkletCleanup = disconnect;
      return true;
    } catch {
      this.callbacks.onMicWarning(
        'No se pudo abrir el micrófono. Puedes conversar escribiendo o usando los disparadores rápidos.'
      );
      return true;
    }
  }

  public stopRadioConversation() {
    this.conversationActive = false;
    if (this.silenceDebounceTimer) clearTimeout(this.silenceDebounceTimer);
    this.callbacks.onConversationActiveChange(false);
    this.callbacks.onMicLevelChange(0);
    this.stopCurrentPlayback();
    this.callbacks.onStatus('idle');
    this.hudClient.updateHud({ speaking: false, listening: false });

    if (this.session) {
      try {
        this.session.close?.();
      } catch {
        // ignore
      }
      this.session = null;
    }
    if (this.micWorkletCleanup) {
      this.micWorkletCleanup();
      this.micWorkletCleanup = null;
    }
    if (this.micAudioCtx) {
      try {
        this.micAudioCtx.close();
      } catch {
        // ignore
      }
      this.micAudioCtx = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
    if (activeBumblebeeSession === this) {
      activeBumblebeeSession = null;
    }
  }
}
