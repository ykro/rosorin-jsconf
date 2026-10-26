import {
  GoogleGenAI,
  type LiveConnectConfig,
  type LiveSendClientContentParameters,
  type LiveSendRealtimeInputParameters,
  type LiveSendToolResponseParameters,
  type LiveServerMessage,
  type Session,
} from '@google/genai';

export const LIVE_MODEL = process.env.NEXT_PUBLIC_GEMINI_LIVE_MODEL || 'gemini-3.8-live';

/**
 * Connection status shown in the UI.
 * - `no_key`: there is no API key, so there is no Live session at all.
 * - `disconnected`: the server closed an idle session; the next action reconnects.
 * - `error`: connecting failed or reconnection attempts were exhausted.
 */
export type LiveStatus =
  | 'idle'
  | 'no_key'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

export interface LiveConnectionOptions {
  /** Prefix for console logs. */
  label: string;
  buildConfig: () => LiveConnectConfig;
  onMessage: (msg: LiveServerMessage) => void;
  onStatus: (status: LiveStatus) => void;
  /** A new socket is open (first connect or reconnect): reset per-session state. */
  onSessionOpened?: (resumed: boolean) => void;
  /** The connection is gone for good (fatal close or retries exhausted). */
  onLost: (reasonEs: string) => void;
  /** Whether an unexpected close should be retried (e.g. a conversation is active). */
  shouldReconnect: () => boolean;
  maxReconnects?: number;
}

const RECONNECT_BACKOFF_MS = [600, 1500, 3500, 6000];
/** 1007: invalid API key / payload, 1008: policy (model not allowed, quota). Retrying will not help. */
const FATAL_CLOSE_CODES = new Set([1007, 1008]);

/**
 * One Gemini Live socket with:
 * - an epoch counter so callbacks from an old socket never touch the new one;
 * - session resumption (handle from `sessionResumptionUpdate`) and sliding-window
 *   context compression;
 * - proactive reconnection on `goAway` and bounded backoff on unexpected closes.
 */
export class LiveConnection {
  private session: Session | null = null;
  private epoch = 0;
  private apiKey = '';
  private resumeHandle: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<boolean> | null = null;
  private readonly opts: LiveConnectionOptions;

  constructor(opts: LiveConnectionOptions) {
    this.opts = opts;
  }

  get isOpen(): boolean {
    return this.session !== null;
  }

  /** Opens the socket if needed. Concurrent callers share the same attempt. */
  async ensure(apiKey: string): Promise<boolean> {
    if (this.session) return true;
    if (this.pending) return this.pending;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.apiKey = apiKey;
    this.reconnectAttempts = 0;
    return this.startOpen('connecting');
  }

  private startOpen(phase: 'connecting' | 'reconnecting'): Promise<boolean> {
    const attempt = this.open(phase).finally(() => {
      if (this.pending === attempt) this.pending = null;
    });
    this.pending = attempt;
    return attempt;
  }

  /** User-initiated close: drops the resumption handle and ignores late callbacks. */
  close() {
    this.epoch += 1;
    this.pending = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const session = this.session;
    this.session = null;
    this.resumeHandle = null;
    this.reconnectAttempts = 0;
    if (session) {
      try {
        session.close();
      } catch (err) {
        console.warn(`[${this.opts.label}] Error al cerrar la sesión Live:`, err);
      }
    }
  }

  sendClientContent(params: LiveSendClientContentParameters): boolean {
    if (!this.session) return false;
    try {
      this.session.sendClientContent(params);
      return true;
    } catch (err) {
      console.warn(`[${this.opts.label}] sendClientContent falló:`, err);
      return false;
    }
  }

  sendRealtimeInput(params: LiveSendRealtimeInputParameters): boolean {
    if (!this.session) return false;
    try {
      this.session.sendRealtimeInput(params);
      return true;
    } catch {
      // A frame lost while the socket is closing is harmless; onclose handles state.
      return false;
    }
  }

  sendToolResponse(params: LiveSendToolResponseParameters): boolean {
    if (!this.session) return false;
    try {
      this.session.sendToolResponse(params);
      return true;
    } catch (err) {
      console.warn(`[${this.opts.label}] sendToolResponse falló:`, err);
      return false;
    }
  }

  private async open(phase: 'connecting' | 'reconnecting'): Promise<boolean> {
    const epoch = ++this.epoch;
    const resumed = Boolean(this.resumeHandle);
    this.opts.onStatus(phase);
    const early: { close: CloseEvent | null } = { close: null };

    try {
      const ai = new GoogleGenAI({ apiKey: this.apiKey, httpOptions: { apiVersion: 'v1alpha' } });
      const config: LiveConnectConfig = {
        ...this.opts.buildConfig(),
        sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
        contextWindowCompression: { slidingWindow: {} },
      };
      const session = await ai.live.connect({
        model: LIVE_MODEL,
        config,
        callbacks: {
          onmessage: (msg: LiveServerMessage) => {
            if (epoch !== this.epoch) return;
            this.handleControlMessage(msg);
            this.opts.onMessage(msg);
          },
          onerror: (e: ErrorEvent) => {
            if (epoch !== this.epoch) return;
            console.warn(`[${this.opts.label}] Error en el socket Live:`, e?.message || e);
          },
          onclose: (e: CloseEvent) => {
            if (epoch !== this.epoch) return;
            if (!this.session) {
              early.close = e;
              return;
            }
            this.session = null;
            this.handleClose(e);
          },
        },
      });

      if (epoch !== this.epoch) {
        session.close();
        return false;
      }
      if (early.close) {
        this.handleClose(early.close);
        return false;
      }
      this.session = session;
      this.reconnectAttempts = 0;
      this.opts.onSessionOpened?.(resumed);
      this.opts.onStatus('live');
      return true;
    } catch (err) {
      if (epoch !== this.epoch) return false;
      console.warn(`[${this.opts.label}] No se pudo conectar a Gemini Live:`, err);
      if (phase === 'reconnecting') {
        this.retryOrGiveUp('No se pudo reconectar con Gemini Live.');
      } else {
        this.opts.onStatus('error');
      }
      return false;
    }
  }

  private handleControlMessage(msg: LiveServerMessage) {
    const update = msg.sessionResumptionUpdate;
    if (update?.resumable && update.newHandle) {
      this.resumeHandle = update.newHandle;
    }
    if (msg.goAway) {
      console.info(`[${this.opts.label}] goAway recibido (quedan ${msg.goAway.timeLeft ?? '?'}); reconectando.`);
      if (this.opts.shouldReconnect()) {
        this.reconnectNow();
      }
    }
  }

  /** Swap to a fresh socket before the server drops the current one. */
  private reconnectNow() {
    const old = this.session;
    this.session = null;
    this.epoch += 1; // ignore the old socket's close
    if (old) {
      try {
        old.close();
      } catch (err) {
        console.warn(`[${this.opts.label}] Error al cerrar la sesión anterior:`, err);
      }
    }
    void this.startOpen('reconnecting');
  }

  private handleClose(e: CloseEvent) {
    const reason = e?.reason ? ` (${e.reason})` : '';
    if (FATAL_CLOSE_CODES.has(e?.code) || /api key/i.test(e?.reason || '')) {
      console.warn(`[${this.opts.label}] Gemini Live cerró la sesión: código ${e?.code}${reason}`);
      this.resumeHandle = null;
      this.opts.onStatus('error');
      this.opts.onLost(`Gemini Live rechazó la sesión${reason}. Revisa la API key y el modelo.`);
      return;
    }
    if (!this.opts.shouldReconnect()) {
      this.opts.onStatus('disconnected');
      return;
    }
    console.info(`[${this.opts.label}] Sesión Live cerrada inesperadamente (código ${e?.code})${reason}.`);
    this.retryOrGiveUp(`Se perdió la conexión con Gemini Live${reason}.`);
  }

  private retryOrGiveUp(reasonEs: string) {
    const max = this.opts.maxReconnects ?? RECONNECT_BACKOFF_MS.length;
    if (!this.opts.shouldReconnect() || this.reconnectAttempts >= max) {
      this.resumeHandle = null;
      this.opts.onStatus('error');
      this.opts.onLost(`${reasonEs} Se agotaron los reintentos.`);
      return;
    }
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempts, RECONNECT_BACKOFF_MS.length - 1)];
    this.reconnectAttempts += 1;
    this.opts.onStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.startOpen('reconnecting');
    }, delay);
  }
}
