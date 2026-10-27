export type LidarSectorName = 'front' | 'left' | 'right' | 'back';

export interface LidarSectors {
  front_m: number;
  left_m: number;
  right_m: number;
  back_m: number;
  obstacle_alert: boolean;
  /**
   * Sectors the LiDAR has no rays in at all (on the ROSOrin Pro the chassis and cables cover the
   * rear: `["back"]`). They read 0.0 but the bridge does not brake on them and leaves them out of
   * `obstacle_alert`. Absent on older bridges and in mock (360°).
   */
  uncovered?: LidarSectorName[];
}

export interface OdometryState {
  x_m: number;
  y_m: number;
  yaw_rad: number;
  vx: number;
  vy: number;
  wz: number;
}

export interface TelemetryState {
  backend: string;
  connected: boolean;
  battery_mv: number;
  servos: Record<string, number>;
  target_servos?: Record<string, number>;
  rgb: [number, number, number];
  active_gesture: string;
  mood: string;
  held_object?: string;
  pointed_totem?: string | null;
  speaking?: boolean;
  listening?: boolean;
  hud_headline?: string;
  hud_subtext?: string;
  odometry: OdometryState;
  lidar: LidarSectors;
  last_command_ms_ago: number;
  timestamp_ms: number;
  /** E-stop latched by `POST /stop`; moving routes answer 423 until `POST /estop/release`. Optional: older bridges and the local fallback omit it. */
  estop_latched?: boolean;
  /** No recent LiDAR scan: the bridge blocks the chassis. */
  lidar_stale?: boolean;
  lidar_source?: 'mock' | 'ros2' | 'none';
}

export type BridgeErrorCode =
  | 'disabled'
  | 'network'
  | 'timeout'
  | 'unauthorized'
  | 'estop_latched'
  | 'forbidden'
  | 'rate_limited'
  | 'invalid_request'
  | 'not_found'
  | 'http'
  // Movement refused by the bridge safety layer (HTTP 200 with `blocked`): the robot did not move.
  | MotionBlockReason
  | 'blocked';

/** `blocked` field of the bridge's movement responses (null or absent: executed). */
export type MotionBlockReason = 'lidar_stale' | 'braked' | 'worker_dead';

/** Outcome of a robot action, as reported to the UI and to Gemini tool responses. */
export interface RobotActionResult {
  ok: boolean;
  /** `robot` when the bridge executed (or rejected) it; `simulator` when only the 3D twin moved. */
  target: 'robot' | 'simulator';
  code?: BridgeErrorCode;
  message: string;
}

export interface RobotActionHandler {
  triggerGesture: (name: string, mood?: string) => Promise<RobotActionResult>;
  moveChassis: (
    linear_x: number,
    linear_y: number,
    angular_z: number,
    duration_ms?: number
  ) => Promise<RobotActionResult>;
}

/** Bridge link state shown in the UI (TopNav, /face). */
export interface BridgeUiState {
  enabled: boolean;
  connected: boolean;
  authError: boolean;
  estopLatched: boolean;
  lidarStale: boolean;
  /** Telemetry says the robot worker/driver is not answering (`connected: false`) while the bridge is up. */
  workerDown: boolean;
  lidarSource?: 'mock' | 'ros2' | 'none';
  url: string;
}

export interface RepoFinding {
  label: string;
  value: string;
  severity: 'good' | 'warn' | 'roast';
}

export interface RepoAnalysis {
  repo: string;
  description: string;
  /** null when GitHub could not be queried (never invented). */
  stars: number | null;
  language: string;
  stack: string[];
  /** null when package.json could not be read (never invented). */
  dependencyCount: number | null;
  hasTests: boolean;
  findings: RepoFinding[];
  suggestedGesture:
    | 'facepalm'
    | 'trash_toss'
    | 'chef_kiss'
    | 'suspicious_inspect'
    | 'victory_spin';
  roastScore: number;
  roastHeadline: string;
  roastPromptContext: string;
  origin: 'github_live' | 'preset_rehearsal' | 'unavailable';
}

export interface ToolCallLog {
  id: string;
  timestamp: string;
  name: string;
  args: Record<string, unknown>;
  latencyMs: number;
  resultSummary: string;
}
