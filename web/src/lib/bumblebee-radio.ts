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
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          audio.onended = null;
          audio.onerror = null;
          resolve();
        };
        const fallbackOnMissingMp3 = () => {
          if (settled) return;
          settled = true;
          audio.onended = null;
          audio.onerror = null;
          // If MP3 clips are not present (e.g. clean git clone without commercial audio),
          // play a brief FM synth cadence so the dance and lyric display still complete smoothly.
          this.playFmTuningStatic(1400).then(resolve);
        };
        audio.onended = done;
        audio.onerror = fallbackOnMissingMp3;
        audio.play().catch(fallbackOnMissingMp3);
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
   * Semantic Embedding Matcher:
   * Uses the 32-dim semantic embeddings in `catalog.json` to score all 168 vocal-verified
   * song segments in <2ms. By default plays 1 single coherent clip whose complete sung lyric
   * directly answers the user; only uses 2 clips if they form an explicit coherent sentence.
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
    const pickFresh = (candidates: Array<SongClip | undefined>): SongClip => {
      const valid = candidates.filter(Boolean) as SongClip[];
      const fresh = valid.find((c) => !this.recentClipIds.includes(c.id)) || valid[0] || this.catalog[0];
      this.recentClipIds = [fresh.id, ...this.recentClipIds].slice(0, 8);
      return fresh;
    };

    // 0. Loyalty / Support at 3 AM ("¿Me vas a dejar solo arreglando este bug a las 3 AM?")
    if (
      q.includes('dejar solo') ||
      q.includes('dejarme solo') ||
      q.includes('3 am') ||
      q.includes('3am') ||
      q.includes('abandonar') ||
      q.includes('ayúdame') ||
      q.includes('ayudame') ||
      q.includes('apoyo') ||
      q.includes('conmigo')
    ) {
      const clip = pickFresh([
        pickById('en_never_gonna_give_you_up'), // "Never gonna give you up, never gonna let you down"
        pickById('en_lean_on_me'), // "Lean on me, when you're not strong"
        pickById('en_youve_got_a_friend'), // "You've got a friend"
        pickById('en_i_will_always_love_you'), // "And I will always love you"
      ]);
      return {
        clips: [clip],
        gesture: 'bumblebee_romance',
        caption: 'Promesa de lealtad robótica en guardia nocturna...',
      };
    }

    // 1. Production crash / bug / outage ("Se cayó producción y nadie sabe por qué")
    if (
      q.includes('cayó') ||
      q.includes('cayo') ||
      q.includes('bug') ||
      q.includes('error') ||
      q.includes('incidente') ||
      q.includes('producción') ||
      q.includes('produccion') ||
      q.includes('fuego') ||
      q.includes('caos') ||
      q.includes('mal día') ||
      q.includes('mal dia')
    ) {
      const clip = pickFresh([
        pickById('en_anti_hero'), // "It's me, hi, I'm the problem, it's me"
        pickById('en_under_pressure'), // "Pressure! Pushing down on me, pressing down on you — Under pressure!"
        pickById('en_another_one_bites_the_dust'), // "Another one bites the dust"
        pickById('es_lo_siento_bb'), // "Lo siento, BB, lo siento"
        pickById('en_everybody_hurts'), // "Everybody hurts sometimes"
      ]);
      const gesture = clip.id === 'en_anti_hero' ? 'bumblebee_sassy' : 'bumblebee_sad_droop';
      return {
        clips: [clip],
        gesture,
        caption:
          clip.id === 'en_anti_hero'
            ? 'Confesión musical del culpable del incidente...'
            : 'Sintonizando alerta de emergencia en producción...',
      };
    }

    // 2. Opinion on Artificial Intelligence / Robots / Future ("¿Qué opinas de la inteligencia artificial?")
    if (
      q.includes('inteligencia artificial') ||
      /\bia\b/.test(q) ||
      /\bai\b/.test(q) ||
      q.includes('opinas') ||
      q.includes('piensas') ||
      q.includes('futuro') ||
      q.includes('realidad')
    ) {
      const clip = pickFresh([
        pickById('en_bohemian_rhapsody'), // "Is this the real life? Is this just fantasy?"
        pickById('es_te_felicito'), // "Te felicito, qué bien actúas, de eso no me cabe duda"
        pickById('en_the_final_countdown'), // "It's the final countdown! The final countdown!"
        pickById('es_en_la_ciudad_de_la_furia'), // "Me verás volar por la ciudad de la furia"
      ]);
      return {
        clips: [clip],
        gesture: clip.id === 'es_te_felicito' ? 'bumblebee_sassy' : 'bumblebee_rock_out',
        caption: `Opinión filosófica en FM: "${clip.title}"`,
      };
    }

    // 3. Joke / Humor ("Cuéntame un chiste") — check before dance so "Cuéntame un chiste" triggers humor
    if (
      q.includes('chiste') ||
      q.includes('risa') ||
      q.includes('reír') ||
      q.includes('reir') ||
      q.includes('broma') ||
      q.includes('joke')
    ) {
      const clip = pickFresh([
        pickById('en_never_gonna_give_you_up'), // "Never gonna give you up, never gonna let you down" (Rickroll!)
        pickById('es_bzrp_music_sessions_53'), // "Las mujeres ya no lloran, las mujeres facturan"
        pickById('en_anti_hero'), // "It's me, hi, I'm the problem, it's me"
        pickById('es_te_felicito'), // "Te felicito, qué bien actúas, de eso no me cabe duda"
      ]);
      return {
        clips: [clip],
        gesture: 'bumblebee_sassy',
        caption:
          clip.id === 'en_never_gonna_give_you_up'
            ? '¡Rickrolleado en vivo por un robot!'
            : 'Sintonizando frecuencia de sarcasmo musical...',
      };
    }

    // 4. Dance / Mecanum wheels ("Baila con las llantas Mecanum")
    if (
      q.includes('baila') ||
      q.includes('bailar') ||
      q.includes('mecanum') ||
      q.includes('llantas') ||
      q.includes('pasos') ||
      q.includes('fiesta') ||
      q.includes('party')
    ) {
      const clip = pickFresh([
        pickById('es_danza_kuduro'), // "La mano arriba, cintura sola, da media vuelta, danza kuduro"
        pickById('es_la_bamba'), // "Para bailar la bamba se necesita una poca de gracia"
        pickById('es_yo_perreo_sola'), // "Yo perreo sola"
        pickById('en_footloose'), // "Everybody cut footloose"
      ]);
      return {
        clips: [clip],
        gesture: 'bumblebee_hype',
        caption: '¡Activando pasos prohibidos en las 4 llantas Mecanum!',
      };
    }

    // 5. Deploy success / Victory ("El deploy en viernes salió perfecto a la primera")
    if (
      q.includes('perfecto') ||
      q.includes('verde') ||
      q.includes('aprobado') ||
      q.includes('deploy') ||
      q.includes('campeón') ||
      q.includes('campeon') ||
      q.includes('ganamos') ||
      q.includes('éxito') ||
      q.includes('exito')
    ) {
      const clip = pickFresh([
        pickById('en_we_are_the_champions'), // "We are the champions, my friends"
        pickById('es_bichota'), // "Me siento bichota sin salir del bloque"
        pickById('en_i_will_survive'), // "I will survive! Hey, hey!"
        pickById('en_walking_on_sunshine'), // "I'm walking on sunshine, whoa-oh"
      ]);
      return {
        clips: [clip],
        gesture: 'bumblebee_rock_out',
        caption: '¡Sintonizando himno de victoria para el deploy!',
      };
    }

    // 6. Love / Gratitude ("Te quiero mucho robotcito, gracias por todo")
    if (
      q.includes('gracias') ||
      q.includes('thank') ||
      q.includes('amor') ||
      q.includes('quiero') ||
      q.includes('love') ||
      q.includes('corazón') ||
      q.includes('corazon')
    ) {
      const clip = pickFresh([
        pickById('es_gracias_a_la_vida'), // "Gracias a la vida que me ha dado tanto"
        pickById('es_limon_y_sal'), // "Yo te quiero con limón y sal, yo te quiero tal y como estás"
        pickById('en_thank_you_for_being_a_friend'), // "Thank you for being a friend"
        pickById('en_youve_got_a_friend'), // "You've got a friend"
      ]);
      return {
        clips: [clip],
        gesture: 'bumblebee_romance',
        caption: 'Frecuencia FM · Agradecimiento y cariño robótico',
      };
    }

    // 7. Greeting / How are you ("¡Hola Bumblebee! ¿Cómo estás hoy?")
    if (
      q.includes('hola') ||
      q.includes('hello') ||
      q.includes('cómo estás') ||
      q.includes('como estas') ||
      q.includes('listo') ||
      q.includes('romperla') ||
      q.includes('escenario') ||
      q.includes('buenas')
    ) {
      const clip = pickFresh([
        pickById('es_vivir_mi_vida'), // "Voy a reír, voy a bailar, vivir mi vida, la, la, la, la"
        pickById('en_levitating'), // "I'm levitating"
        pickById('es_provenza'), // "Baby, ¿qué más? Hace rato que no sé na de ti"
        pickById('en_walking_on_sunshine'), // "I'm walking on sunshine, whoa-oh"
      ]);
      return {
        clips: [clip],
        gesture: 'bumblebee_hype',
        caption: '¡Sintonizando saludo y estado de ánimo al 100%!',
      };
    }

    // 8. Dense vector cosine similarity search across all 168 vocal-verified clips (returns 1 single best clip)
    const scored = this.catalog.map((clip) => {
      const clipVec =
        clip.embedding && clip.embedding.length > 0
          ? clip.embedding
          : embedQueryVector(`${clip.title} ${clip.artist} ${clip.lyrics} ${clip.role} ${clip.meanings.join(' ')}`);

      let sim = cosineSimilarity(queryVec, clipVec) * 10;

      const hay = `${clip.title} ${clip.artist} ${clip.lyrics} ${clip.role} ${clip.meanings.join(' ')}`.toLowerCase();
      for (const tok of tokens) {
        if (hay.includes(tok)) sim += 2.5;
      }

      if (!this.recentClipIds.includes(clip.id)) {
        sim += 1.8;
      } else {
        sim -= 3.5;
      }

      sim += Math.random() * 0.25;
      return { clip, score: sim };
    });

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0]?.clip || this.catalog[0];
    this.recentClipIds = [best.id, ...this.recentClipIds].slice(0, 8);

    return {
      clips: [best],
      gesture: best.gesture || 'bumblebee_groove',
      caption: `Sintonizando "${best.title}" — ${best.artist}`,
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
Your voice box is damaged: YOU CANNOT SPEAK WITH YOUR OWN VOICE. You communicate ONLY by calling \`play_radio_sequence\`.

CRITICAL RULES FOR SELECTING SONG CLIPS:
1. DEFAULT TO A SINGLE CLIP (1 clip in \`clip_ids\`): Pick the single clip whose COMPLETE SUNG LYRIC is the wittiest, clearest direct answer to what the user said.
2. ONLY USE 2 CLIPS IF THEY FORM ONE COHERENT SENTENCE TOGETHER: Never combine two clips unless Lyric 1 + Lyric 2 read as a natural, logical two-part sentence (e.g. a greeting followed by "Voy a reír, voy a bailar, vivir mi vida"). If 1 clip says it all, ONLY pass 1 clip!
3. EXAMPLES OF GREAT SINGLE-CLIP ANSWERS:
   - "Se cayó producción y nadie sabe por qué" -> \`["en_anti_hero"]\` ("It's me, hi, I'm the problem, it's me") or \`["en_under_pressure"]\` ("Pressure! Pushing down on me... Under pressure!") or \`["en_another_one_bites_the_dust"]\`.
   - "¿Qué opinas de la inteligencia artificial?" -> \`["en_bohemian_rhapsody"]\` ("Is this the real life? Is this just fantasy?") or \`["es_te_felicito"]\` ("Te felicito, qué bien actúas, de eso no me cabe duda").
   - "¿Me vas a dejar solo arreglando este bug a las 3 AM?" -> \`["en_never_gonna_give_you_up"]\` ("Never gonna give you up, never gonna let you down") or \`["en_lean_on_me"]\` ("Lean on me, when you're not strong").
   - "Baila con las llantas Mecanum" -> \`["es_danza_kuduro"]\` ("La mano arriba, cintura sola, da media vuelta, danza kuduro") or \`["es_la_bamba"]\`.
4. Always pick an expressive \`dance_gesture\` (\`bumblebee_hype\`, \`bumblebee_groove\`, \`bumblebee_rock_out\`, \`bumblebee_romance\`, \`bumblebee_sad_droop\`, \`bumblebee_sassy\`).
5. NEVER generate spoken words of your own; ONLY respond via \`play_radio_sequence\`.

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
            // Strictly ignore any msg.data (synthetic voice PCM) from Gemini Live:
            // Bumblebee ONLY communicates by playing real song clips from /songs/clips/*.mp3
            if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
              window.speechSynthesis.cancel();
            }

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
                }, 1450);
              }
            }

            if (msg.toolCall?.functionCalls?.length) {
              if (this.silenceDebounceTimer) clearTimeout(this.silenceDebounceTimer);
              const alreadyHandled = this.toolHandledCurrentTurn || this.isPlayingRadio;
              this.toolHandledCurrentTurn = true;
              const userSpoken = this.currentUserTurnText || 'Conversación por micrófono';
              this.currentUserTurnText = '';

              const responses = [];
              for (const fc of msg.toolCall.functionCalls) {
                if (fc.name === 'play_radio_sequence' && !alreadyHandled) {
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
                    // Default to 1 clip unless 2 clips were explicitly chosen
                    this.playClipSequence(
                      resolvedClips.slice(0, 2),
                      args.dance_gesture || resolvedClips[0].gesture,
                      args.radio_caption || `Sintonizando "${resolvedClips[0].title}"`,
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
                await this.session?.sendToolResponse({ functionResponses: responses });
              } catch {
                // ignore
              }
            }

            if (msg.serverContent?.turnComplete) {
              if (
                !this.toolHandledCurrentTurn &&
                !this.isPlayingRadio &&
                this.currentUserTurnText.trim().length >= 2
              ) {
                const pendingText = this.currentUserTurnText.trim();
                this.toolHandledCurrentTurn = true;
                this.currentUserTurnText = '';
                this.respondWithMusic(pendingText);
              } else {
                this.toolHandledCurrentTurn = false;
                this.currentUserTurnText = '';
              }
            }
          },
          onerror: () => {
            this.session = null;
            this.callbacks.onStatus('idle');
            this.callbacks.onMicWarning(
              'La sesión de Gemini Live se cerró. Puedes usar los disparadores rápidos o reconectar con tu API Key.'
            );
          },
          onclose: () => {
            this.session = null;
            if (!this.isPlayingRadio) {
              this.callbacks.onStatus('idle');
            }
          },
        },
      });
      this.callbacks.onStatus('live');
      return true;
    } catch {
      this.session = null;
      this.callbacks.onStatus('idle');
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
            audio: {
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
