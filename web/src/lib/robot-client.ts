import type { TelemetryState } from './types';

export function resolveBridgeUrl(): string {
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('bridge');
    if (fromQuery) {
      window.localStorage.setItem('ROSORIN_BRIDGE_URL', fromQuery);
      return fromQuery;
    }
    const fromStorage = window.localStorage.getItem('ROSORIN_BRIDGE_URL');
    if (
      fromStorage &&
      fromStorage !== 'http://localhost:9090' &&
      fromStorage !== 'http://localhost:9000'
    ) {
      return fromStorage;
    }
    if (process.env.NEXT_PUBLIC_BRIDGE_URL) return process.env.NEXT_PUBLIC_BRIDGE_URL;
    return `http://${window.location.hostname || 'localhost'}:9000`;
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

export class RobotBridgeClient {
  private baseUrl: string;
  private ws: WebSocket | null = null;
  private onTelemetry?: (state: TelemetryState) => void;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(baseUrl = resolveBridgeUrl(), onTelemetry?: (state: TelemetryState) => void) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.onTelemetry = onTelemetry;
  }

  public connectWebSocket() {
    if (typeof window === 'undefined') return;
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws';
    try {
      this.ws = new WebSocket(wsUrl);
      this.ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as TelemetryState;
          this.onTelemetry?.({ ...data, connected: true });
        } catch {
          // ignore malformed frame
        }
      };
      this.ws.onclose = () => {
        this.reconnectTimer = setTimeout(() => this.connectWebSocket(), 2000);
      };
      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      // Fallback to HTTP if WS unavailable
    }
  }

  public disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  public async triggerGesture(name: string, mood?: string): Promise<TelemetryState> {
    const res = await fetch(`${this.baseUrl}/gesture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mood }),
    });
    const data = (await res.json()) as { telemetry: TelemetryState };
    return data.telemetry;
  }

  public async moveChassis(
    linear_x: number,
    linear_y: number,
    angular_z: number,
    duration_ms = 550
  ): Promise<TelemetryState> {
    const res = await fetch(`${this.baseUrl}/cmd_vel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ linear_x, linear_y, angular_z, duration_ms }),
    });
    const data = (await res.json()) as { telemetry: TelemetryState };
    return data.telemetry;
  }

  public async setArm(
    servos: Array<{ id: number; position: number }>,
    duration_ms = 400
  ): Promise<TelemetryState> {
    const res = await fetch(`${this.baseUrl}/arm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration_ms, servos }),
    });
    const data = (await res.json()) as { telemetry: TelemetryState };
    return data.telemetry;
  }

  public async jogServo(id: number, delta: number): Promise<TelemetryState> {
    const res = await fetch(`${this.baseUrl}/servo/jog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, delta }),
    });
    const data = (await res.json()) as { telemetry: TelemetryState };
    return data.telemetry;
  }

  public async resetScene(): Promise<TelemetryState> {
    const res = await fetch(`${this.baseUrl}/scene/reset`, {
      method: 'POST',
    });
    const data = (await res.json()) as { telemetry: TelemetryState };
    return data.telemetry;
  }

  public async emergencyStop(): Promise<TelemetryState> {
    const res = await fetch(`${this.baseUrl}/stop`, { method: 'POST' });
    const data = (await res.json()) as { telemetry: TelemetryState };
    return data.telemetry;
  }

  public async simulateLidarDistance(front_m: number): Promise<TelemetryState> {
    const res = await fetch(`${this.baseUrl}/simulate/lidar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ front_m }),
    });
    const data = (await res.json()) as { telemetry: TelemetryState };
    return data.telemetry;
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
      });
    } catch {
      // ignore if bridge does not support or is unreachable
    }
  }

  public getCameraFrameUrl(cacheBust = Date.now()): string {
    return `${this.baseUrl}/camera/frame?t=${cacheBust}`;
  }
}
