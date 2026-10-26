import type { TelemetryState } from './types';

function isAllowedBridgeUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname;
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)
    );
  } catch {
    return false;
  }
}

export function resolveBridgeUrl(): string {
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('bridge');
    if (fromQuery === 'reset') {
      window.localStorage.removeItem('ROSORIN_BRIDGE_URL');
    } else if (fromQuery && isAllowedBridgeUrl(fromQuery)) {
      window.localStorage.setItem('ROSORIN_BRIDGE_URL', fromQuery);
      return fromQuery;
    }
    const fromStorage = window.localStorage.getItem('ROSORIN_BRIDGE_URL');
    if (fromStorage && isAllowedBridgeUrl(fromStorage)) {
      return fromStorage;
    }
    if (process.env.NEXT_PUBLIC_BRIDGE_URL) {
      return process.env.NEXT_PUBLIC_BRIDGE_URL;
    }
    const host = window.location.hostname || 'localhost';
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      /^192\.168\./.test(host) ||
      /^10\./.test(host)
    ) {
      return `http://${host}:9000`;
    }
    return 'http://localhost:9000';
  }
  return process.env.NEXT_PUBLIC_BRIDGE_URL || 'http://localhost:9000';
}

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

const BRIDGE_TIMEOUT_MS = 800;

export class RobotBridgeClient {
  private baseUrl: string;
  private ws: WebSocket | null = null;
  private onTelemetry?: (state: TelemetryState) => void;
  private onConnectionChange?: (connected: boolean) => void;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;

  constructor(
    baseUrl = resolveBridgeUrl(),
    onTelemetry?: (state: TelemetryState) => void,
    onConnectionChange?: (connected: boolean) => void
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.onTelemetry = onTelemetry;
    this.onConnectionChange = onConnectionChange;
  }

  public connectWebSocket() {
    if (typeof window === 'undefined' || this.closedByUser) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws';
    try {
      const sock = new WebSocket(wsUrl);
      this.ws = sock;
      sock.onmessage = (ev) => {
        if (this.closedByUser) return;
        try {
          const data = JSON.parse(ev.data) as TelemetryState;
          this.onConnectionChange?.(true);
          this.onTelemetry?.({ ...data, connected: true });
        } catch {
          // ignore malformed frame
        }
      };
      sock.onclose = () => {
        this.onConnectionChange?.(false);
        if (!this.closedByUser) {
          this.reconnectTimer = setTimeout(() => this.connectWebSocket(), 2500);
        }
      };
      sock.onerror = () => {
        this.onConnectionChange?.(false);
        try {
          sock.close();
        } catch {
          // ignore
        }
      };
    } catch {
      this.onConnectionChange?.(false);
    }
  }

  public disconnect() {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.onConnectionChange?.(false);
  }

  private async postJson(path: string, body?: unknown): Promise<TelemetryState> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Bridge HTTP ${res.status} on ${path}`);
    }
    const data = (await res.json()) as { telemetry: TelemetryState };
    return data.telemetry;
  }

  public async triggerGesture(name: string, mood?: string): Promise<TelemetryState> {
    return this.postJson('/gesture', { name, mood });
  }

  public async moveChassis(
    linear_x: number,
    linear_y: number,
    angular_z: number,
    duration_ms = 550
  ): Promise<TelemetryState> {
    return this.postJson('/cmd_vel', { linear_x, linear_y, angular_z, duration_ms });
  }

  public async setArm(
    servos: Array<{ id: number; position: number }>,
    duration_ms = 400
  ): Promise<TelemetryState> {
    return this.postJson('/arm', { duration_ms, servos });
  }

  public async jogServo(id: number, delta: number): Promise<TelemetryState> {
    return this.postJson('/servo/jog', { id, delta });
  }

  public async resetScene(): Promise<TelemetryState> {
    return this.postJson('/scene/reset');
  }

  public async emergencyStop(): Promise<TelemetryState> {
    return this.postJson('/stop');
  }

  public async simulateLidarDistance(front_m: number): Promise<TelemetryState> {
    return this.postJson('/simulate/lidar', { front_m });
  }

  public async updateHud(payload: {
    speaking?: boolean;
    listening?: boolean;
    headline?: string;
    subtext?: string;
    mood?: string;
  }): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/hud`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
      });
    } catch {
      // ignore if bridge does not support or is unreachable
    }
  }

  public getCameraFrameUrl(cacheBust = Date.now()): string {
    return `${this.baseUrl}/camera/frame?t=${cacheBust}`;
  }
}
