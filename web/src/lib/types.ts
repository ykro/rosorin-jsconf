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
  /** «Reconocer» (`POST /scan_env`): sweep progress and measured props. Absent on older bridges. */
  scan_env?: ScanEnvStatus;
  /**
   * Where the props really are in a simulated stage (the mock bridge's `GET /simulate/scene`, or
   * the twin-only simulation). Never sent by the bridge in telemetry and absent with the real
   * robot, which has no ground truth: the twin then only knows what «Reconocer» measured.
   */
  sim_scene?: SimSceneObject[] | null;
}

/** A prop of a simulated stage, odometry/world frame (m, REP-103). */
export interface SimSceneObject {
  id: ScanPropId;
  x_m: number;
  y_m: number;
}

/** Stage of a «Reconocer» scan: Demo B (trays) or Demo C (totems). */
export type ScanScene = 'gatekeeper' | 'bughunter';

export type ScanPropId = 'approve_tray' | 'reject_tray' | 'cloud_run' | 'gemini_live' | 'firestore';

/** A prop measured by «Reconocer», in the robot frame at scan time (`odom_at_scan`). */
export interface SceneDetection {
  id: ScanPropId;
  label: string;
  x_m: number;
  y_m: number;
  z_m: number;
  /** REP-103: 0 = front, + = left. */
  bearing_deg: number;
  distance_m: number;
  confidence: number;
  views: number;
  method: 'plane' | 'depth' | 'mock' | string;
  lidar_confirmed: boolean | null;
  joint1_target: number;
}

/** `GET /scan_env` and `telemetry.scan_env`. */
export interface ScanEnvStatus {
  state: 'idle' | 'running' | 'done' | 'aborted';
  scene: ScanScene | null;
  step: number;
  steps: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
  reason: 'estop' | 'interrupted' | 'worker_dead' | null;
  failed_captures: number;
  last_error: string | null;
  detections: SceneDetection[];
  odom_at_scan: { x_m: number; y_m: number; yaw_rad: number } | null;
  fresh: boolean;
  stale_reason: string | null;
}

/** `aim` of a prop gesture's `/gesture` response: measured target or the fixed side. */
export interface GestureAim {
  source: 'measured' | 'default';
  object: ScanPropId;
  joint1: number;
  bearing_deg: number | null;
  distance_m: number | null;
  confidence: number | null;
  reason: string | null;
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
  // POST /scan_env: a sweep is already running (409) / the bridge cannot scan (503)
  | 'scan_running'
  | 'unavailable'
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
