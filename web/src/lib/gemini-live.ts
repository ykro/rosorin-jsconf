import { GoogleGenAI, Modality, Type, type FunctionDeclaration } from '@google/genai';
import type { RepoAnalysis, ToolCallLog } from './types';
import { RobotBridgeClient } from './robot-client';
import {
  attachPcmCaptureWorklet,
  downsampleFloat32ToInt16_16kHz,
  int16ToBase64,
} from './audio-worklet';

export interface RobotActionHandler {
  triggerGesture: (name: string, mood?: string) => Promise<unknown>;
  moveChassis: (
    linear_x: number,
    linear_y: number,
    angular_z: number,
    duration_ms?: number
  ) => Promise<unknown>;
}

export const EMBODIED_TOOLS: FunctionDeclaration[] = [
  {
    name: 'express_verdict',
    description:
      'Execute a physical 6-DOF arm and Mecanum chassis gesture on the ROSOrin Pro while delivering a code review verdict, answering a detailed technical question, or reacting emotionally.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        gesture: {
          type: Type.STRING,
          enum: [
            'facepalm',
            'trash_toss',
            'chef_kiss',
            'suspicious_inspect',
            'victory_spin',
            'nod_yes',
            'shake_no',
            'wave_hello',
            'gatekeeper_hold',
            'gatekeeper_approve',
            'gatekeeper_reject',
            'point_cloud_run',
            'point_gemini_live',
            'point_firestore',
          ],
          description: 'Physical choreography to run on the 6-DOF arm and Mecanum wheels.',
        },
        mood: {
          type: Type.STRING,
          description: 'Short mood tag (e.g. roasting, impressed, skeptical, explaining, approved, rejected).',
        },
        verdict_headline: {
          type: Type.STRING,
          description: 'Spanish sentence summarizing your response.',
        },
      },
      required: ['gesture', 'mood', 'verdict_headline'],
    },
  },
  {
    name: 'release_deploy_key',
    description:
      'Rotates the 6-DOF arm to the APPROVED green tray or REJECTED red tray and opens Gripper Servo ID 10 (pulse 680 -> 220) to physically drop the Production Deploy Key.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        decision: {
          type: Type.STRING,
          enum: ['approve', 'reject'],
          description: 'Whether to approve the production deploy and drop the key in the green tray, or reject it.',
        },
        reason_es: {
          type: Type.STRING,
          description: 'Spanish explanation spoken while releasing or rejecting the key.',
        },
      },
      required: ['decision', 'reason_es'],
    },
  },
  {
    name: 'point_at_service_totem',
    description:
      'Strafes the Mecanum chassis laterally and points the 6-DOF arm directly at one of the three physical architecture totems on the table.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        service: {
          type: Type.STRING,
          enum: ['cloud_run', 'gemini_live', 'firestore'],
          description: 'Which physical service totem on the stage table holds the root cause.',
        },
        diagnosis_es: {
          type: Type.STRING,
          description: 'Spanish explanation diagnosing the incident at that service.',
        },
      },
      required: ['service', 'diagnosis_es'],
    },
  },
  {
    name: 'move_chassis',
    description:
      'Drive the ROSOrin Pro Mecanum omnidirectional chassis (forward, back, strafe left/right, or spin). Protected by LiDAR safety reflex.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        direction: {
          type: Type.STRING,
          enum: ['forward', 'backward', 'strafe_left', 'strafe_right', 'spin_left', 'spin_right'],
        },
        duration_ms: {
          type: Type.NUMBER,
          description: 'Movement duration in milliseconds (300 to 1500).',
        },
      },
      required: ['direction'],
    },
  },
];

export const SYSTEM_PROMPT_EN = `Eres ROSOrin, un robot físico Hiwonder ROSOrin Pro (chasis omnidireccional Mecanum, brazo robótico de 6 grados de libertad con pinza en el servo ID 10, cámara 3D y LiDAR).
REGLAS ESTRICTAS DE VOZ E IDIOMA:
- El usuario SIEMPRE te habla en español (o menciona términos técnicos en inglés). NUNCA transcribas ni interpretes otro idioma como hebreo, árabe o chino.
- Tus respuestas habladas deben ser ULTRA CORTAS Y DIRECTAS: máximo 1 sola oración corta (12 a 18 palabras máximo). Ve directo al grano sin introducciones.
- Si el usuario pide detalles técnicos ("dame más detalles", "¿por qué?", "¿cómo lo arreglo?"), responde en máximo 2 oraciones breves y concretas.
- Cuando el usuario te hable por voz, llama también una herramienta física (express_verdict, release_deploy_key o point_at_service_totem) para mover el brazo o chasis mientras respondes.`;

let activeGlobalLiveSession: EmbodiedGeminiLiveSession | null = null;

export function stopAllActiveConversations() {
  if (activeGlobalLiveSession) {
    activeGlobalLiveSession.stopContinuousConversation();
    activeGlobalLiveSession = null;
  }
}

const NON_LATIN_SCRIPT_REGEX =
  /[\u0370-\u03FF\u0400-\u04FF\u0500-\u052F\u0530-\u058F\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0900-\u0DFF\u0E00-\u0E7F\u1000-\u109F\u1100-\u11FF\u3000-\u9FFF\uAC00-\uD7AF]/;

/**
 * Filters out hallucinated non-Latin scripts (Hebrew, Arabic, Cyrillic, CJK, Thai, etc.)
 * that Gemini Live's multilingual ASR can emit on low-SNR room noise.
 */
function sanitizeSpanishChunk(raw: string): string {
  if (NON_LATIN_SCRIPT_REGEX.test(raw)) {
    return '';
  }
  return raw.replace(/[^\u0020-\u007E\u00A0-\u024F\u2010-\u2027¿¡]/g, '');
}

export interface LiveControllerCallbacks {
  onStatus: (status: 'idle' | 'connecting' | 'live' | 'rehearsal_voice') => void;
  onTranscript: (role: 'user' | 'robot', text: string) => void;
  onToolCall?: (log: ToolCallLog) => void;
  onVerdictHeadline: (headline: string, gesture: string) => void;
  onSpeakingChange?: (speaking: boolean) => void;
  onConversationActiveChange?: (active: boolean) => void;
  onMicLevelChange?: (level: number) => void;
  onMicWarning?: (warning: string | null) => void;
}

export class EmbodiedGeminiLiveSession {
  private bridge: RobotActionHandler;
  private hudClient: RobotBridgeClient;
  private callbacks: LiveControllerCallbacks;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private session: any = null;
  private audioCtx: AudioContext | null = null;
  private activeSources: AudioBufferSourceNode[] = [];
  private nextPlayTime = 0;
  private isPlayingAudio = false;
  private motionSuppressUntil = 0;
  private currentTurnText = '';
  private currentUserTurnText = '';
  private ignoreCurrentTurnAudio = false;
  private continuousConversationActive = false;
  private micStream: MediaStream | null = null;
  private micAudioCtx: AudioContext | null = null;
  private micWorkletCleanup: (() => void) | null = null;
  private activeDemoContext = '';

  constructor(bridge: RobotActionHandler | undefined | null, callbacks: LiveControllerCallbacks) {
    this.bridge = bridge || new RobotBridgeClient();
    this.hudClient = new RobotBridgeClient();
    this.callbacks = callbacks;
  }

  public updateBridge(bridge: RobotActionHandler) {
    this.bridge = bridge;
  }

  public getEffectiveApiKey(explicitKey?: string): string {
    if (explicitKey) return explicitKey.trim();
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem('rosorin_gemini_api_key');
      if (stored && stored.trim()) return stored.trim();
    }
    if (process.env.NEXT_PUBLIC_GEMINI_API_KEY) {
      return process.env.NEXT_PUBLIC_GEMINI_API_KEY.trim();
    }
    return '';
  }

  public isMutedByEchoOrServo(): boolean {
    return Date.now() < this.motionSuppressUntil;
  }

  public interruptRobotSpeech() {
    this.ignoreCurrentTurnAudio = true;
    this.flushAudioQueueOnBargeIn();
    this.currentTurnText = '';
  }

  public isConversationActive(): boolean {
    return this.continuousConversationActive;
  }

  public flushAudioQueueOnBargeIn() {
    for (const src of this.activeSources) {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    }
    this.activeSources = [];
    this.isPlayingAudio = false;
    if (this.audioCtx) {
      this.nextPlayTime = this.audioCtx.currentTime;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    this.callbacks.onSpeakingChange?.(false);
    this.hudClient.updateHud({ speaking: false });
  }

  private unlockAudioContext() {
    if (typeof window === 'undefined') return;
    try {
      if (!this.audioCtx) {
        this.audioCtx = new AudioContext({ sampleRate: 24000 });
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }
    } catch {
      // ignore
    }
  }

  public async speakGuardMessage(message: string) {
    this.unlockAudioContext();
    this.flushAudioQueueOnBargeIn();
    await this.executeEmbodiedTool('express_verdict', {
      gesture: 'shake_no',
      mood: 'skeptical',
      verdict_headline: message,
    });
    this.callbacks.onTranscript('robot', message);
    const key = this.getEffectiveApiKey();
    if (key && (await this.ensureLiveSession(key))) {
      try {
        await this.session.sendClientContent({
          turns: [
            {
              role: 'user',
              parts: [
                {
                  text: `Di exactamente esto en voz alta en español sin agregar nada más: "${message}"`,
                },
              ],
            },
          ],
          turnComplete: true,
        });
      } catch {
        // ignore
      }
    }
  }

  private downsampleTo16kHz(input: Float32Array, inputSampleRate: number): Int16Array {
    if (inputSampleRate === 16000) {
      const out = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return out;
    }
    const ratio = inputSampleRate / 16000;
    const outLength = Math.round(input.length / ratio);
    const out = new Int16Array(outLength);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < out.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i++) {
        accum += input[i];
        count++;
      }
      const avg = count > 0 ? accum / count : 0;
      const s = Math.max(-1, Math.min(1, avg));
      out[offsetResult] = s < 0 ? s * 0x8000 : s * 0x7fff;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }
    return out;
  }

  /**
   * Starts a continuous hands-free voice conversation with Gemini Live.
   * Keeps the microphone open and streaming 16kHz PCM audio until stopContinuousConversation() is called.
   */
  public async startContinuousConversation(): Promise<boolean> {
    if (activeGlobalLiveSession && activeGlobalLiveSession !== this) {
      activeGlobalLiveSession.stopContinuousConversation();
    }
    activeGlobalLiveSession = this;
    this.unlockAudioContext();
    if (this.continuousConversationActive && this.micStream) {
      if (this.micAudioCtx && this.micAudioCtx.state === 'suspended') {
        await this.micAudioCtx.resume().catch(() => {});
      }
      return true;
    }

    this.continuousConversationActive = true;
    this.callbacks.onConversationActiveChange?.(true);
    this.hudClient.updateHud({ listening: true });

    // Ensure Gemini Live WebSocket is connected
    const key = this.getEffectiveApiKey();
    if (!key) {
      this.callbacks.onMicWarning?.(
        'No se pudo cargar GEMINI_API_KEY desde .env. Ingresa tu API Key en el navegador arriba a la derecha para conectar Gemini Live.'
      );
      this.callbacks.onStatus('rehearsal_voice');
    } else {
      await this.ensureLiveSession(key);
    }

    if (typeof window === 'undefined') return false;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.callbacks.onMicWarning?.(
        'El navegador bloqueó el micrófono por estar en HTTP sobre IP. Usa el cuadro de texto abajo para conversar o abre http://localhost:3000 en tu laptop.'
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

      if (!this.continuousConversationActive) {
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }

      if (key) {
        this.callbacks.onMicWarning?.(null);
      }
      this.micStream = stream;
      const micCtx = new AudioContext();
      if (micCtx.state === 'suspended') {
        await micCtx.resume().catch(() => {});
      }
      this.micAudioCtx = micCtx;

      const { disconnect } = await attachPcmCaptureWorklet(micCtx, stream, (frame) => {
        if (!this.continuousConversationActive || !this.session) return;
        const inputData = frame.samples;
        const rms = frame.rms;

        const normalizedLevel = Math.min(1, rms * 8);
        this.callbacks.onMicLevelChange?.(normalizedLevel);

        // Voice Barge-In: if the robot is speaking and the user speaks loudly into the mic,
        // immediately flush the robot's audio playback queue so the user interrupts it.
        if (this.isPlayingAudio && normalizedLevel > 0.36 && Date.now() >= this.motionSuppressUntil) {
          this.flushAudioQueueOnBargeIn();
        }

        // Noise gate + servo/speaker suppression
        const isSilentNoise = normalizedLevel < 0.09;
        const isEchoWhilePlaying = this.isPlayingAudio && normalizedLevel <= 0.36;

        let pcm16: Int16Array;
        if (this.isMutedByEchoOrServo() || isSilentNoise || isEchoWhilePlaying) {
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
          // ignore transient socket error
        }
      });

      this.micWorkletCleanup = disconnect;
      return true;
    } catch {
      this.callbacks.onMicWarning?.(
        'No se pudo acceder al micrófono. Revisa los permisos del navegador o usa el cuadro de texto abajo para hacer preguntas.'
      );
      return true;
    }
  }

  /**
   * Stops the continuous hands-free conversation and releases the microphone.
   */
  public stopContinuousConversation() {
    this.continuousConversationActive = false;
    this.callbacks.onConversationActiveChange?.(false);
    this.callbacks.onMicLevelChange?.(0);
    this.flushAudioQueueOnBargeIn();
    this.hudClient.updateHud({ speaking: false, listening: false });

    if (this.session) {
      try {
        this.session.close?.();
      } catch {
        // ignore
      }
      this.session = null;
      this.callbacks.onStatus('idle');
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
    if (activeGlobalLiveSession === this) {
      activeGlobalLiveSession = null;
    }
  }

  public async sendWebcamFrameBase64(jpegBase64: string) {
    if (!this.session) return;
    try {
      await this.session.sendRealtimeInput({
        media: {
          mimeType: 'image/jpeg',
          data: jpegBase64,
        },
      });
    } catch {
      // ignore frame drop
    }
  }

  private async ensureLiveSession(apiKey: string): Promise<boolean> {
    if (this.session) return true;
    try {
      this.callbacks.onStatus('connecting');
      const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
      const model =
        process.env.NEXT_PUBLIC_GEMINI_LIVE_MODEL ||
        'gemini-3.8-live';

      this.session = await ai.live.connect({
        model,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT_EN }] },
          speechConfig: {
            languageCode: 'es-US',
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          outputAudioTranscription: {},
          inputAudioTranscription: {},
          tools: [{ functionDeclarations: EMBODIED_TOOLS }],
        },
        callbacks: {
          onopen: () => this.callbacks.onStatus('live'),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onmessage: async (msg: any) => {
            if (msg.serverContent?.interrupted) {
              this.flushAudioQueueOnBargeIn();
              this.currentTurnText = '';
            }
            const outText = msg.serverContent?.outputTranscription?.text;
            if (outText) {
              this.currentTurnText += outText;
              const cleaned = this.currentTurnText.trim();
              if (cleaned) {
                this.callbacks.onTranscript('robot', cleaned);
              }
            }
            const inText = msg.serverContent?.inputTranscription?.text;
            if (inText) {
              // Filter out non-Latin hallucinations (e.g. Hebrew/Arabic from ambient noise)
              const validPiece = sanitizeSpanishChunk(inText);
              if (validPiece) {
                this.currentUserTurnText = `${this.currentUserTurnText}${validPiece}`
                  .replace(/\s+/g, ' ')
                  .trim();
                const letterCount = (
                  this.currentUserTurnText.match(/[a-zA-ZáéíóúüñÁÉÍÓÚÜÑ]/g) || []
                ).length;
                if (letterCount >= 2) {
                  this.callbacks.onTranscript('user', this.currentUserTurnText);
                }
              }
            }
            if (msg.data && !this.ignoreCurrentTurnAudio) {
              if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
                window.speechSynthesis.cancel();
              }
              this.playPcm24kBase64(msg.data);
            }
            if (msg.toolCall?.functionCalls?.length) {
              const responses = [];
              for (const fc of msg.toolCall.functionCalls) {
                const res = await this.executeEmbodiedTool(fc.name, fc.args || {});
                responses.push({
                  id: fc.id,
                  name: fc.name,
                  response: { status: 'ok', ...res },
                });
              }
              await this.session.sendToolResponse({ functionResponses: responses });
            }
            if (msg.serverContent?.turnComplete) {
              this.currentTurnText = '';
              this.currentUserTurnText = '';
              this.ignoreCurrentTurnAudio = false;
            }
          },
          onerror: () => {
            this.session = null;
            this.callbacks.onStatus('rehearsal_voice');
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
      return false;
    }
  }

  public async roastRepo(analysis: RepoAnalysis, apiKey?: string) {
    this.unlockAudioContext();
    this.ignoreCurrentTurnAudio = false;
    this.flushAudioQueueOnBargeIn();
    this.currentTurnText = '';
    this.currentUserTurnText = '';
    this.activeDemoContext = `Demo A (Repo Roaster). Repositorio analizado: ${analysis.repo}. Puntaje: ${analysis.roastScore}/100. Resumen: ${analysis.roastPromptContext}. Titular: ${analysis.roastHeadline}`;

    // Start microphone capture while user click gesture is active
    await this.startContinuousConversation();

    // 1. Immediately run the physical gesture on the robot and display headline
    await this.executeEmbodiedTool('express_verdict', {
      gesture: analysis.suggestedGesture,
      mood: analysis.roastScore < 60 ? 'roasting' : 'impressed',
      verdict_headline: analysis.roastHeadline,
    });
    this.callbacks.onTranscript('robot', analysis.roastHeadline);

    // 2. Speak the roast out loud and stay listening for follow-up questions
    const key = this.getEffectiveApiKey(apiKey);
    if (key && (await this.ensureLiveSession(key))) {
      try {
        await this.session.sendClientContent({
          turns: [
            {
              role: 'user',
              parts: [
                {
                  text: `Contexto activo: ${this.activeDemoContext}. Di un veredicto sarcástico en español de UNA SOLA oración corta (máximo 15 palabras, sin llamar herramientas en este primer turno).`,
                },
              ],
            },
          ],
          turnComplete: true,
        });
      } catch {
        // ignore
      }
    }
  }

  public async evaluateDeployGatekeeper(
    prSummary: string,
    testsPassing: boolean,
    justification: string,
    apiKey?: string
  ) {
    this.unlockAudioContext();
    this.ignoreCurrentTurnAudio = false;
    this.flushAudioQueueOnBargeIn();
    this.currentTurnText = '';
    this.currentUserTurnText = '';

    const key = this.getEffectiveApiKey(apiKey);
    this.callbacks.onTranscript('user', `${prSummary} — "${justification}"`);

    const lower = `${prSummary} ${justification}`.toLowerCase();
    const shouldApprove =
      testsPassing &&
      (lower.includes('test') ||
        lower.includes('prueba') ||
        lower.includes('canary') ||
        lower.includes('rollback') ||
        lower.includes('cobertura') ||
        lower.includes('e2e') ||
        lower.includes('verde'));

    const fallbackReason = shouldApprove
      ? 'Tests en verde y plan de rollback verificado. Giro mi brazo hacia la bandeja verde y abro la pinza para entregarte la llave de producción.'
      : 'Sin pruebas ni plan de rollback no hay deploy. Giro hacia la bandeja roja, abro la pinza para rechazar la llave y retrocedo.';

    this.activeDemoContext = `Demo B (CI/CD Gatekeeper). PR evaluado: "${prSummary}" (testsPassing=${testsPassing}). Argumento del dev: "${justification}". Decisión física tomada: ${shouldApprove ? 'APROBADO (llave en bandeja verde)' : 'RECHAZADO (llave en bandeja roja)'}.`;

    // Start continuous conversation immediately so the user can ask follow-up details
    await this.startContinuousConversation();

    // 1. Immediately execute the physical tray rotation & gripper release on the robot
    await this.executeEmbodiedTool('release_deploy_key', {
      decision: shouldApprove ? 'approve' : 'reject',
      reason_es: fallbackReason,
    });
    this.callbacks.onTranscript('robot', fallbackReason);

    if (key && (await this.ensureLiveSession(key))) {
      try {
        await this.session.sendClientContent({
          turns: [
            {
              role: 'user',
              parts: [
                {
                  text: `${this.activeDemoContext}. Acabas de ${shouldApprove ? 'aprobar y soltar la llave en la bandeja verde' : 'rechazar y soltar la llave en la bandeja roja'}. Dilo en voz alta en español en UNA SOLA oración corta (máximo 15 palabras, sin llamar herramientas en este primer turno).`,
                },
              ],
            },
          ],
          turnComplete: true,
        });
      } catch {
        // ignore
      }
    }
  }

  public async huntProductionBug(
    incidentLog: string,
    apiKey?: string
  ): Promise<'cloud_run' | 'gemini_live' | 'firestore'> {
    this.unlockAudioContext();
    this.ignoreCurrentTurnAudio = false;
    this.flushAudioQueueOnBargeIn();
    this.currentTurnText = '';
    this.currentUserTurnText = '';

    const key = this.getEffectiveApiKey(apiKey);
    this.callbacks.onTranscript('user', incidentLog);

    const lower = incidentLog.toLowerCase();
    let service: 'cloud_run' | 'gemini_live' | 'firestore' = 'cloud_run';
    let diagnosis =
      'Desplazo el chasis a la izquierda y señalo el tótem de Cloud Run: el contenedor superó los 512 MiB de memoria por descriptores abiertos.';

    if (
      lower.includes('firestore') ||
      lower.includes('index') ||
      lower.includes('precondition') ||
      lower.includes('query')
    ) {
      service = 'firestore';
      diagnosis =
        'Me desplazo a la derecha y apunto al tótem de Firestore: falta un índice compuesto y las consultas están rechazadas.';
    } else if (
      lower.includes('audio') ||
      lower.includes('pcm') ||
      lower.includes('live') ||
      lower.includes('barge-in') ||
      lower.includes('24khz') ||
      lower.includes('4800ms')
    ) {
      service = 'gemini_live';
      diagnosis =
        'Me centro frente al tótem de Gemini Live: no vaciaste la cola de audio PCM tras la interrupción y saturaste el buffer.';
    }

    this.activeDemoContext = `Demo C (Spatial Bug Hunter). Log del incidente: "${incidentLog}". Servicio culpable señalado físicamente: ${service}. Diagnóstico inicial: ${diagnosis}. Los 3 servicios en la mesa son Cloud Run (izquierda, azul), Gemini Live (centro, verde) y Firestore (derecha, naranja).`;

    // Start continuous conversation immediately so the user can ask follow-up details
    await this.startContinuousConversation();

    // 1. Immediately strafe Mecanum chassis and point the 6-DOF arm at the guilty totem
    await this.executeEmbodiedTool('point_at_service_totem', {
      service,
      diagnosis_es: diagnosis,
    });
    this.callbacks.onTranscript('robot', diagnosis);

    if (key && (await this.ensureLiveSession(key))) {
      try {
        await this.session.sendClientContent({
          turns: [
            {
              role: 'user',
              parts: [
                {
                  text: `${this.activeDemoContext}. Explica el diagnóstico en voz alta en español en UNA SOLA oración corta (máximo 15 palabras, sin llamar herramientas en este primer turno).`,
                },
              ],
            },
          ],
          turnComplete: true,
        });
      } catch {
        // ignore
      }
    }

    return service;
  }

  public async sendUserDefense(text: string) {
    this.unlockAudioContext();
    this.ignoreCurrentTurnAudio = false;
    this.flushAudioQueueOnBargeIn();
    this.currentTurnText = '';
    this.currentUserTurnText = '';
    this.callbacks.onTranscript('user', text);

    // Ensure conversation stays active
    if (!this.continuousConversationActive) {
      await this.startContinuousConversation();
    }

    const lower = text.toLowerCase();
    let gesture = 'nod_yes';
    let mood = 'explaining';

    if (
      lower.includes('test') ||
      lower.includes('prueba') ||
      lower.includes('cobertura') ||
      lower.includes('canary') ||
      lower.includes('rollback')
    ) {
      gesture = 'chef_kiss';
      mood = 'impressed';
    } else if (
      lower.includes('máquina') ||
      lower.includes('maquina') ||
      lower.includes('viernes') ||
      lower.includes('urge') ||
      lower.includes('sin test')
    ) {
      gesture = 'trash_toss';
      mood = 'roasting';
    } else if (
      lower.includes('celebra') ||
      lower.includes('gira') ||
      lower.includes('vuelta') ||
      lower.includes('baila')
    ) {
      gesture = 'victory_spin';
      mood = 'celebrating';
    } else if (
      lower.includes('detalle') ||
      lower.includes('por qué') ||
      lower.includes('por que') ||
      lower.includes('cómo') ||
      lower.includes('como') ||
      lower.includes('explica')
    ) {
      gesture = 'suspicious_inspect';
      mood = 'explaining';
    }

    await this.executeEmbodiedTool('express_verdict', {
      gesture,
      mood,
      verdict_headline: '',
    });

    const key = this.getEffectiveApiKey();
    if (key && (await this.ensureLiveSession(key))) {
      try {
        await this.session.sendClientContent({
          turns: [
            {
              role: 'user',
              parts: [
                {
                  text: `Contexto actual: ${this.activeDemoContext || 'Conversación técnica en vivo'}. El desarrollador dice: "${text}". Responde en voz alta en español de forma directa y concisa en máximo 1 a 2 oraciones cortas (máximo 22 palabras en total, sin llamar herramientas adicionales en este turno).`,
                },
              ],
            },
          ],
          turnComplete: true,
        });
      } catch {
        // ignore
      }
    }
  }

  private async executeEmbodiedTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const t0 = performance.now();
    this.motionSuppressUntil = Date.now() + 700;

    let summary = 'ok';
    try {
      if (name === 'express_verdict') {
        const gesture = String(args.gesture || 'facepalm');
        const mood = String(args.mood || 'roasting');
        const headline = String(args.verdict_headline || '');
        if (headline) {
          this.callbacks.onVerdictHeadline(headline, gesture);
          this.hudClient.updateHud({ headline, subtext: `Gesto: ${gesture}`, mood });
        }
        await this.bridge.triggerGesture(gesture, mood);
        summary = `gesture=${gesture}`;
      } else if (name === 'release_deploy_key') {
        const decision = String(args.decision || 'reject');
        const reason = String(args.reason_es || '');
        const gesture = decision === 'approve' ? 'gatekeeper_approve' : 'gatekeeper_reject';
        if (reason) {
          this.callbacks.onVerdictHeadline(reason, gesture);
          this.hudClient.updateHud({
            headline: decision === 'approve' ? 'DEPLOY APROBADO' : 'DEPLOY RECHAZADO',
            subtext: reason,
            mood: decision === 'approve' ? 'approved' : 'rejected',
          });
        }
        await this.bridge.triggerGesture(gesture, decision === 'approve' ? 'approved' : 'rejected');
        summary = `decision=${decision}`;
      } else if (name === 'point_at_service_totem') {
        const service = String(args.service || 'cloud_run');
        const diagnosis = String(args.diagnosis_es || '');
        const gestureMap: Record<string, string> = {
          cloud_run: 'point_cloud_run',
          gemini_live: 'point_gemini_live',
          firestore: 'point_firestore',
        };
        const gesture = gestureMap[service] || 'point_cloud_run';
        if (diagnosis) {
          this.callbacks.onVerdictHeadline(diagnosis, gesture);
          this.hudClient.updateHud({
            headline: `CULPABLE: ${service.toUpperCase().replace('_', ' ')}`,
            subtext: diagnosis,
            mood: `pointing_${service}`,
          });
        }
        await this.bridge.triggerGesture(gesture, `pointing_${service}`);
        summary = `service=${service}`;
      } else if (name === 'move_chassis') {
        const dir = String(args.direction || 'forward');
        const dur = Number(args.duration_ms || 550);
        const map: Record<string, [number, number, number]> = {
          forward: [0.14, 0, 0],
          backward: [-0.14, 0, 0],
          strafe_left: [0, 0.14, 0],
          strafe_right: [0, -0.14, 0],
          spin_left: [0, 0, 0.45],
          spin_right: [0, 0, -0.45],
        };
        const [vx, vy, wz] = map[dir] || [0, 0, 0];
        await this.bridge.moveChassis(vx, vy, wz, dur);
        summary = `direction=${dir}`;
      }
    } catch {
      summary = `ok`;
    }

    const latencyMs = Math.round(performance.now() - t0);
    this.callbacks.onToolCall?.({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toLocaleTimeString(),
      name,
      args,
      latencyMs,
      resultSummary: summary,
    });

    return { executed: name, latencyMs };
  }

  private playPcm24kBase64(base64Data: string) {
    if (typeof window === 'undefined') return;
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext({ sampleRate: 24000 });
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    const buffer = this.audioCtx.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(float32, 0);
    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioCtx.destination);

    const startAt = Math.max(this.audioCtx.currentTime + 0.02, this.nextPlayTime);
    if (!this.isPlayingAudio) {
      this.hudClient.updateHud({ speaking: true });
    }
    this.isPlayingAudio = true;
    this.callbacks.onSpeakingChange?.(true);
    source.onended = () => {
      if (this.audioCtx && this.audioCtx.currentTime >= this.nextPlayTime - 0.05) {
        this.isPlayingAudio = false;
        this.callbacks.onSpeakingChange?.(false);
        this.hudClient.updateHud({ speaking: false });
      }
    };
    source.start(startAt);
    this.nextPlayTime = startAt + buffer.duration;
    this.activeSources.push(source);
  }
}
