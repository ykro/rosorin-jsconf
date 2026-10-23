export interface LidarSectors {
  front_m: number;
  left_m: number;
  right_m: number;
  back_m: number;
  obstacle_alert: boolean;
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
}

export interface RepoFinding {
  label: string;
  value: string;
  severity: 'good' | 'warn' | 'roast';
}

export interface RepoAnalysis {
  repo: string;
  description: string;
  stars: number;
  language: string;
  stack: string[];
  dependencyCount: number;
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
  origin: 'github_live' | 'preset_rehearsal';
}

export interface ToolCallLog {
  id: string;
  timestamp: string;
  name: string;
  args: Record<string, unknown>;
  latencyMs: number;
  resultSummary: string;
}
