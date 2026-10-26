import type {
  BridgeErrorCode,
  RobotActionHandler,
  RobotActionResult,
  TelemetryState,
} from './types';
import {
  getBridgeToken,
  isBridgeEnabled,
  resolveBridgeUrl,
} from './bridge-config';
import { clampChassisVelocity, clampArmDurationMs, clampChassisDurationMs } from './tool-args';

export { resolveBridgeUrl } from './bridge-config';

export const DEFAULT_BRIDGE_URL =
  process.env.NEXT_PUBLIC_BRIDGE_URL || 'http://localhost:9000';

export const FALLBACK_TELEMETRY: TelemetryState = {
  backend: 'browser-fallback',
  connected: false,
  battery_mv: 11850,
  servos: { '1': 500, '2': 430, '3': 310, '4': 380, '5': 500, '10': 500 },
  rgb: [15, 118, 110],
  active_gesture: 'home',
  mood: 'attentive',
  held_object: 'deploy_key',
  pointed_totem: null,
  odometry: { x_m: 0, y_m: 0, yaw_rad: 0, vx: 0, vy: 0, wz: 0 },
  lidar: {
    front_m: 1.42,
    left_m: 1.85,
    right_m: 1.76,
    back_m: 2.1,
    obstacle_alert: false,
  },
  last_command_ms_ago: 0,
  timestamp_ms: Date.now(),
};

/** Fired on `window` whenever the bridge answers 401. */
export const BRIDGE_AUTH_ERROR_EVENT = 'rosorin-bridge-auth-error';

const BRIDGE_TIMEOUT_MS = 800;
const WS_RECONNECT_MIN_MS = 1000;
const WS_RECONNECT_MAX_MS = 30000;

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly status?: number;

  constructor(code: BridgeErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.status = status;
  }
}

export function describeBridgeError(err: unknown): { code: BridgeErrorCode; message: string } {
  if (err instanceof BridgeError) return { code: err.code, message: err.message };
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'network', message: `No se pudo contactar al bridge: ${message}` };
}

export interface BridgeLinkState {
  connected: boolean;
  authError: boolean;
}

export class RobotBridgeClient {
  private readonly fixedBaseUrl?: string;
  private ws: WebSocket | null = null;
  private onTelemetry?: (state: TelemetryState) => void;
  private onLinkChange?: (state: BridgeLinkState) => void;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = WS_RECONNECT_MIN_MS;
  private closedByUser = false;
  private link: BridgeLinkState = { connected: false, authError: false };

  constructor(
    baseUrl?: string,
    onTelemetry?: (state: TelemetryState) => void,
    onLinkChange?: (state: BridgeLinkState) => void
  ) {
    this.fixedBaseUrl = baseUrl ? baseUrl.replace(/\/+$/, '') : undefined;
    this.onTelemetry = onTelemetry;
    this.onLinkChange = onLinkChange;
  }

  public get baseUrl(): string {
    return this.fixedBaseUrl ?? resolveBridgeUrl();
  }

  private setLink(next: BridgeLinkState) {
    if (next.connected === this.link.connected && next.authError === this.link.authError) return;
    this.link = next;
    this.onLinkChange?.(next);
  }

  private authHeaders(): Record<string, string> {
    const token = getBridgeToken();
    return token ? { 'x-bridge-token': token } : {};
  }

  public connectWebSocket() {
    if (typeof window === 'undefined' || this.closedByUser) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!isBridgeEnabled()) {
      this.setLink({ connected: false, authError: false });
      return;
    }

    const token = getBridgeToken();
    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/ws${
      token ? `?token=${encodeURIComponent(token)}` : ''
    }`;
    let receivedAny = false;
    let sock: WebSocket;
    try {
      sock = new WebSocket(wsUrl);
    } catch (err) {
      console.warn('[bridge] No se pudo abrir el WebSocket:', err);
      this.scheduleReconnect();
      return;
    }
    this.ws = sock;

    sock.onmessage = (ev) => {
      if (this.closedByUser || this.ws !== sock) return;
      try {
        const data = JSON.parse(ev.data) as TelemetryState & {
          event?: string;
          op?: string;
          status?: string;
          message?: string;
        };
        receivedAny = true;
        if (data.event !== undefined) {
          // Not telemetry: command errors sent over the socket ({"event":"error",...}).
          if (data.event === 'error') {
            console.warn(`[bridge] Error por WebSocket en ${data.op ?? '?'} (${data.status ?? '?'}): ${data.message ?? ''}`);
          }
          return;
        }
        this.reconnectDelayMs = WS_RECONNECT_MIN_MS;
        this.setLink({ connected: true, authError: false });
        this.onTelemetry?.({ ...data, connected: true });
      } catch (err) {
        console.warn('[bridge] Frame de telemetría inválido:', err);
      }
    };
    sock.onerror = () => {
      // The browser fires `close` right after `error`; reconnection is handled there.
    };
    sock.onclose = () => {
      if (this.ws === sock) this.ws = null;
      if (this.closedByUser) return;
      this.setLink({ connected: false, authError: this.link.authError });
      if (receivedAny) {
        this.scheduleReconnect();
        return;
      }
      // A WebSocket handshake rejected with 401 is indistinguishable from "bridge down"
      // in the browser, so ask an HTTP endpoint with the same token.
      void this.probeUnauthorized().then((unauthorized) => {
        if (this.closedByUser) return;
        if (unauthorized) {
          this.setLink({ connected: false, authError: true });
          window.dispatchEvent(new Event(BRIDGE_AUTH_ERROR_EVENT));
          return; // no retry loop with the same bad token; a token change recreates the client
        }
        this.scheduleReconnect();
      });
    };
  }

  private scheduleReconnect() {
    if (this.closedByUser || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(WS_RECONNECT_MAX_MS, delay * 2);
    if (delay === WS_RECONNECT_MIN_MS) {
      console.info(`[bridge] Sin conexión con ${this.baseUrl}; reintentando con backoff (máx. ${WS_RECONNECT_MAX_MS / 1000} s).`);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, delay);
  }

  private async probeUnauthorized(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/status`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(1500),
      });
      return res.status === 401;
    } catch {
      return false; // unreachable: plain reconnect with backoff
    }
  }

  public disconnect() {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const sock = this.ws;
      sock.onclose = null;
      sock.onerror = null;
      sock.onmessage = null;
      try {
        sock.close();
      } catch (err) {
        console.warn('[bridge] Error al cerrar el WebSocket:', err);
      }
      this.ws = null;
    }
    this.setLink({ connected: false, authError: false });
  }

  private async postJson(path: string, body?: unknown): Promise<TelemetryState | null> {
    if (!isBridgeEnabled()) {
      throw new BridgeError('disabled', 'Bridge desactivado en esta página (solo simulador 3D).');
    }
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
      throw new BridgeError(
        timedOut ? 'timeout' : 'network',
        timedOut
          ? `El bridge no respondió en ${BRIDGE_TIMEOUT_MS} ms (${path}).`
          : `No se pudo contactar al bridge en ${this.baseUrl} (${path}).`
      );
    }
    if (!res.ok) {
      // The bridge answers errors as JSON: {"status":"<code>","message":"<es>"}.
      let detail = '';
      try {
        const data = (await res.json()) as { message?: string };
        if (typeof data?.message === 'string') detail = data.message;
      } catch {
        // body is optional
      }
      switch (res.status) {
        case 401:
          if (typeof window !== 'undefined') window.dispatchEvent(new Event(BRIDGE_AUTH_ERROR_EVENT));
          throw new BridgeError('unauthorized', 'El bridge pide token (401).', 401);
        case 403:
          throw new BridgeError(
            'forbidden',
            `El bridge rechazó el origen o el host de esta página (403)${detail ? `: ${detail}` : ''}.`,
            403
          );
        case 423:
          throw new BridgeError(
            'estop_latched',
            detail || 'Paro de emergencia activo: el robot no se moverá hasta liberarlo.',
            423
          );
        case 429:
          throw new BridgeError('rate_limited', 'Demasiadas órdenes por segundo: el bridge limitó la petición (429).', 429);
        case 400:
          throw new BridgeError('invalid_request', `Parámetros inválidos en ${path}${detail ? `: ${detail}` : ''} (400).`, 400);
        case 404:
          throw new BridgeError('not_found', `El bridge no reconoce ${path} o su parámetro${detail ? `: ${detail}` : ''} (404).`, 404);
        default:
          throw new BridgeError('http', `El bridge respondió HTTP ${res.status} en ${path}${detail ? `: ${detail}` : ''}.`, res.status);
      }
    }
    try {
      const data = (await res.json()) as { telemetry?: TelemetryState };
      return data?.telemetry ?? null;
    } catch {
      return null;
    }
  }

  public async triggerGesture(name: string, mood?: string): Promise<TelemetryState | null> {
    return this.postJson('/gesture', { name, mood });
  }

  public async moveChassis(
    linear_x: number,
    linear_y: number,
    angular_z: number,
    duration_ms = 550
  ): Promise<TelemetryState | null> {
    const v = clampChassisVelocity(linear_x, linear_y, angular_z);
    return this.postJson('/cmd_vel', { ...v, duration_ms: clampChassisDurationMs(duration_ms) });
  }

  public async setArm(
    servos: Array<{ id: number; position: number }>,
    duration_ms = 400
  ): Promise<TelemetryState | null> {
    return this.postJson('/arm', { duration_ms: clampArmDurationMs(duration_ms), servos });
  }

  public async jogServo(id: number, delta: number): Promise<TelemetryState | null> {
    return this.postJson('/servo/jog', { id, delta });
  }

  public async resetScene(): Promise<TelemetryState | null> {
    return this.postJson('/scene/reset');
  }

  /** Latches the E-stop on the bridge (moving routes answer 423 until released). */
  public async emergencyStop(): Promise<TelemetryState | null> {
    return this.postJson('/stop');
  }

  public async releaseEstop(): Promise<TelemetryState | null> {
    return this.postJson('/estop/release');
  }

  public async simulateLidarDistance(front_m: number): Promise<TelemetryState | null> {
    return this.postJson('/simulate/lidar', { front_m });
  }

  public async updateHud(payload: {
    speaking?: boolean;
    listening?: boolean;
    headline?: string;
    subtext?: string;
    mood?: string;
  }): Promise<void> {
    if (!isBridgeEnabled()) return;
    try {
      await this.postJson('/hud', payload);
    } catch (err) {
      // The HUD is cosmetic (/face); never block a demo on it.
      console.debug('[bridge] HUD no actualizado:', describeBridgeError(err).message);
    }
  }
}

/** Adapts a bare client into the RobotActionHandler contract used by Gemini sessions. */
export function createBridgeActionHandler(client: RobotBridgeClient): RobotActionHandler {
  const run = async (fn: () => Promise<unknown>): Promise<RobotActionResult> => {
    if (!isBridgeEnabled()) {
      return { ok: true, target: 'simulator', message: 'Sin robot conectado: acción solo en el simulador.' };
    }
    try {
      await fn();
      return { ok: true, target: 'robot', message: 'Ejecutado en el robot.' };
    } catch (err) {
      const { code, message } = describeBridgeError(err);
      return { ok: false, target: 'robot', code, message };
    }
  };
  return {
    triggerGesture: (name, mood) => run(() => client.triggerGesture(name, mood)),
    moveChassis: (vx, vy, wz, ms) => run(() => client.moveChassis(vx, vy, wz, ms)),
  };
}
