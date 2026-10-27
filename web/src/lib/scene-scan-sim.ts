/**
 * «Reconocer» simulated in the browser-only twin (no bridge, or a bridge that does not answer).
 *
 * A 1:1 port of the bridge's mock path (robot-bridge/src/scan_env.rs): the same sweep (survey pose,
 * joint1 280 → 720 in 11 pauses, same durations), the same simulated stage, the same simulated camera
 * (a prop is seen only while it is inside the camera's ±34° cone and 8-90 cm from the joint1 axis),
 * the same merge of the views and the same aiming of the prop gestures (bearing → joint1, clamped to
 * 250-750, fixed side without a fresh scan). Pure functions: the timers live in use-robot-telemetry.
 */
import type { GestureStepData } from './gesture-choreographies.generated';
import type { ScanEnvStatus, ScanPropId, ScanScene, SceneDetection } from './types';
import { PROP_LABELS, SCAN_SCENE_PROPS } from './scene-scan';

export const SCAN_STEPS = 11;
export const SCAN_J1_MIN = 280;
export const SCAN_J1_MAX = 720;
/** Servos 2-4 of the survey pose / home (servos 5 and 10 are never touched). */
export const SURVEY_POSE: ReadonlyArray<[number, number]> = [
  [2, 520],
  [3, 200],
  [4, 180],
];
export const HOME_POSE: ReadonlyArray<[number, number]> = [
  [2, 430],
  [3, 310],
  [4, 380],
];
export const SURVEY_MOVE_MS = 1500;
export const STEP_MOVE_MS = 600;
export const SETTLE_MS = 500;
export const HOME_MOVE_MS = 1500;
export const AIM_J1_MIN = 250;
export const AIM_J1_MAX = 750;
export const SCENE_MAX_AGE_MS = 15 * 60 * 1000;
export const MOVED_TOLERANCE_M = 0.15;
export const MOVED_TOLERANCE_RAD = (15 * Math.PI) / 180;
export const MIN_AIM_CONFIDENCE = 0.45;
/** joint1 axis in base_link (URDF), the center the arm turns about. */
export const J1_AXIS_X_M = 0.04662;
/** Bus servos: 1000 pulses = 240°. */
export const PULSE_DEG = 0.24;
export const INLIER_RADIUS_M = 0.08;
export const TOP_VIEWS = 3;
/** Simulated camera: half of the horizontal field of view. */
export const MOCK_HALF_FOV_DEG = 34;

export interface Pose2D {
  x_m: number;
  y_m: number;
  yaw_rad: number;
}

/** A prop of the simulated stage, odometry/world frame. */
export interface SimObject {
  id: ScanPropId;
  x_m: number;
  y_m: number;
}

/**
 * Same stage as the bridge's mock (`default_sim_scene`): on purpose NOT the fixed layout of the
 * gestures (the trays are swapped, the totems shuffled), so «Reconocer» visibly changes where the
 * twin draws them and where the gestures aim.
 */
export const DEFAULT_SIM_SCENE: readonly SimObject[] = [
  { id: 'approve_tray', x_m: 0.22, y_m: -0.15 },
  { id: 'reject_tray', x_m: 0.17, y_m: 0.2 },
  { id: 'cloud_run', x_m: 0.36, y_m: -0.19 },
  { id: 'gemini_live', x_m: 0.33, y_m: 0.21 },
  { id: 'firestore', x_m: 0.39, y_m: 0.04 },
];

/** One prop seen in one capture, base_link frame. */
export interface CaptureDetection {
  id: ScanPropId;
  x_m: number;
  y_m: number;
  z_m: number;
  confidence: number;
}

const toDeg = (r: number) => (r * 180) / Math.PI;
const wrapDeg = (a: number) => toDeg(Math.atan2(Math.sin((a * Math.PI) / 180), Math.cos((a * Math.PI) / 180)));
const roundTo = (v: number, decimals: number) => {
  const k = 10 ** decimals;
  return Math.round(v * k) / k;
};

export function toWorld(pose: Pose2D, x: number, y: number): [number, number] {
  const c = Math.cos(pose.yaw_rad);
  const s = Math.sin(pose.yaw_rad);
  return [pose.x_m + c * x - s * y, pose.y_m + s * x + c * y];
}

export function toRobot(pose: Pose2D, wx: number, wy: number): [number, number] {
  const c = Math.cos(pose.yaw_rad);
  const s = Math.sin(pose.yaw_rad);
  const dx = wx - pose.x_m;
  const dy = wy - pose.y_m;
  return [c * dx + s * dy, -s * dx + c * dy];
}

function movedFrom(pose: Pose2D, other: Pose2D): boolean {
  const d = pose.yaw_rad - other.yaw_rad;
  const dyaw = Math.atan2(Math.sin(d), Math.cos(d));
  return Math.hypot(pose.x_m - other.x_m, pose.y_m - other.y_m) > MOVED_TOLERANCE_M || Math.abs(dyaw) > MOVED_TOLERANCE_RAD;
}

/** joint1 pulses of the sweep, evenly spaced from right to left. */
export function sweepPositions(): number[] {
  const span = SCAN_J1_MAX - SCAN_J1_MIN;
  return Array.from({ length: SCAN_STEPS }, (_, i) => SCAN_J1_MIN + Math.round((span * i) / (SCAN_STEPS - 1)));
}

/** joint1 pulse that turns the arm toward (x, y) in base_link (> 500 = left), clamped to 250-750. */
export function joint1ForPoint(x: number, y: number): number {
  const angleDeg = toDeg(Math.atan2(y, x - J1_AXIS_X_M));
  const pulse = Math.round(500 + angleDeg / PULSE_DEG);
  return Math.max(AIM_J1_MIN, Math.min(AIM_J1_MAX, pulse));
}

/** Where joint1 at `pulse` points the arm, in degrees (REP-103, + = left). */
export function joint1HeadingDeg(pulse: number): number {
  return (pulse - 500) * PULSE_DEG;
}

const isTray = (id: string) => id.endsWith('_tray');

/**
 * Whether the simulated camera, with the robot at `odom` and joint1 at `j1Pulse`, sees the world
 * point (wx, wy): inside ±34° of where the arm points and 8-90 cm from the joint1 axis. `offDeg` is
 * how far from the image center it falls; (x, y) is the point in base_link.
 */
export function inCameraCone(
  odom: Pose2D,
  j1Pulse: number,
  wx: number,
  wy: number
): { inside: boolean; offDeg: number; x: number; y: number } {
  const [x, y] = toRobot(odom, wx, wy);
  const reach = Math.hypot(x - J1_AXIS_X_M, y);
  const offDeg = wrapDeg(toDeg(Math.atan2(y, x - J1_AXIS_X_M)) - joint1HeadingDeg(j1Pulse));
  return { inside: Math.abs(offDeg) <= MOCK_HALF_FOV_DEG && reach >= 0.08 && reach <= 0.9, offDeg, x, y };
}

/**
 * What the simulated camera sees with joint1 at `j1Pulse`: the props of `scene` inside its cone
 * (±34° of where the arm points, 8-90 cm from the joint1 axis), with a confidence that drops toward
 * the edge of the image.
 */
export function simCapture(
  scene: ScanScene,
  sim: readonly SimObject[],
  odom: Pose2D,
  j1Pulse: number
): CaptureDetection[] {
  const wanted = SCAN_SCENE_PROPS[scene];
  const out: CaptureDetection[] = [];
  for (const o of sim) {
    if (!wanted.includes(o.id)) continue;
    const { inside, offDeg: off, x, y } = inCameraCone(odom, j1Pulse, o.x_m, o.y_m);
    if (!inside) continue;
    out.push({
      id: o.id,
      x_m: x,
      y_m: y,
      z_m: isTray(o.id) ? -0.025 : 0.055,
      confidence: roundTo(0.95 * (1 - (0.4 * Math.abs(off)) / 37.6), 3),
    });
  }
  return out;
}

/**
 * Merges the views of the sweep into one detection per prop (same as `aggregate` in scan_env.rs):
 * best view, the views within 8 cm of it, confidence-weighted mean of the 3 best of those;
 * one lone view counts half.
 */
export function aggregate(scene: ScanScene, captures: readonly CaptureDetection[][]): SceneDetection[] {
  const out: SceneDetection[] = [];
  for (const id of SCAN_SCENE_PROPS[scene]) {
    const views = captures
      .flat()
      .filter((d) => d.id === id && [d.x_m, d.y_m, d.z_m, d.confidence].every(Number.isFinite) && d.confidence > 0)
      .sort((a, b) => b.confidence - a.confidence);
    if (views.length === 0) continue;
    const best = views[0];
    const inliers = views.filter((d) => Math.hypot(d.x_m - best.x_m, d.y_m - best.y_m) <= INLIER_RADIUS_M);
    const top = inliers.slice(0, TOP_VIEWS);
    const wsum = top.reduce((s, d) => s + d.confidence, 0);
    const mean = (f: (d: CaptureDetection) => number) => top.reduce((s, d) => s + f(d) * d.confidence, 0) / wsum;
    const x = mean((d) => d.x_m);
    const y = mean((d) => d.y_m);
    const z = mean((d) => d.z_m);
    const coverage = Math.min(1, inliers.length / 2);
    const confidence = Math.max(0, Math.min(1, (wsum / top.length) * (0.5 + 0.5 * coverage)));
    out.push({
      id,
      label: PROP_LABELS[id],
      x_m: roundTo(x, 4),
      y_m: roundTo(y, 4),
      z_m: roundTo(z, 4),
      bearing_deg: roundTo(toDeg(Math.atan2(y, x)), 1),
      distance_m: roundTo(Math.hypot(x, y), 3),
      confidence: roundTo(confidence, 3),
      views: inliers.length,
      method: 'sim',
      lidar_confirmed: null,
      joint1_target: joint1ForPoint(x, y),
    });
  }
  return out;
}

export function idleScan(): ScanEnvStatus {
  return {
    state: 'idle',
    scene: null,
    step: 0,
    steps: SCAN_STEPS,
    started_at_ms: null,
    finished_at_ms: null,
    reason: null,
    failed_captures: 0,
    last_error: null,
    detections: [],
    odom_at_scan: null,
    fresh: false,
    stale_reason: 'no_scan',
  };
}

export function runningScan(scene: ScanScene, nowMs: number): ScanEnvStatus {
  return { ...idleScan(), state: 'running', scene, started_at_ms: nowMs, stale_reason: 'running' };
}

/** `fresh` / `stale_reason` for the current odometry and time (moved is sticky, like the bridge). */
export function refreshScan(scan: ScanEnvStatus, odom: Pose2D, nowMs: number): ScanEnvStatus {
  let reason: string | null;
  let moved = scan.stale_reason === 'moved';
  if (scan.state === 'idle') reason = 'no_scan';
  else if (scan.state === 'running') reason = 'running';
  else if (scan.state === 'aborted') reason = 'aborted';
  else {
    if (scan.odom_at_scan && movedFrom(odom, scan.odom_at_scan)) moved = true;
    if (moved) reason = 'moved';
    else if (scan.finished_at_ms !== null && nowMs - scan.finished_at_ms > SCENE_MAX_AGE_MS) reason = 'expired';
    else if (scan.detections.length === 0) reason = 'not_found';
    else reason = null;
  }
  const fresh = reason === null;
  if (fresh === scan.fresh && reason === scan.stale_reason) return scan;
  return { ...scan, fresh, stale_reason: reason };
}

/** Gestures that aim at a stage prop: prop id and the fixed joint1 used without a scan. */
export const AIM_OBJECTS: Record<string, [ScanPropId, number]> = {
  gatekeeper_approve: ['approve_tray', 700],
  gatekeeper_reject: ['reject_tray', 280],
  point_cloud_run: ['cloud_run', 610],
  point_gemini_live: ['gemini_live', 500],
  point_firestore: ['firestore', 390],
};

export type AimResult =
  | { ok: true; joint1: number; x_m: number; y_m: number; confidence: number }
  | { ok: false; reason: 'no_scan' | 'running' | 'aborted' | 'moved' | 'expired' | 'not_found' | 'low_confidence' };

/** The measured aim for `object`, or why the gesture must use its fixed side (same as `aim_for`). */
export function aimFor(scan: ScanEnvStatus, object: ScanPropId, odom: Pose2D, nowMs: number): AimResult {
  const s = refreshScan(scan, odom, nowMs);
  if (!s.fresh && s.stale_reason !== 'not_found') {
    const r = s.stale_reason;
    return { ok: false, reason: r === 'running' || r === 'aborted' || r === 'moved' || r === 'expired' ? r : 'no_scan' };
  }
  const d = s.detections.find((x) => x.id === object);
  if (!d) return { ok: false, reason: 'not_found' };
  if (d.confidence < MIN_AIM_CONFIDENCE) return { ok: false, reason: 'low_confidence' };
  const [wx, wy] = toWorld(s.odom_at_scan ?? { x_m: 0, y_m: 0, yaw_rad: 0 }, d.x_m, d.y_m);
  const [x, y] = toRobot(odom, wx, wy);
  return { ok: true, joint1: joint1ForPoint(x, y), x_m: x, y_m: y, confidence: d.confidence };
}

/**
 * Aims a prop gesture at a measured joint1 (same as `aim_gesture` in gestures.rs): every aiming step
 * turns joint1 there and no longer strafes or advances; only `gatekeeper_reject` keeps its first two
 * steps (the refusal shake) and its final back-off.
 */
export function aimSteps(canonical: string, steps: readonly GestureStepData[], joint1: number): GestureStepData[] {
  const firstAimed = canonical === 'gatekeeper_reject' ? 2 : 0;
  return steps.map((step, i) => {
    if (i < firstAimed) return step;
    const servos = [...step.servos] as GestureStepData['servos'];
    servos[0] = joint1;
    const velocity: GestureStepData['velocity'] = step.velocity
      ? step.velocity[0] < 0
        ? [step.velocity[0], 0, 0]
        : [0, 0, 0]
      : null;
    return { ...step, servos, velocity };
  });
}

/** One keyframe of the simulated sweep: at `atMs` the arm heads to `servos` over `moveMs`. */
export interface SweepKeyframe {
  atMs: number;
  moveMs: number;
  /** Servo id → pulse (only 1-4; 5 and 10 are never touched). */
  servos: Record<string, number>;
  /** 1-based pause reached at this keyframe (null for the survey move and the return home). */
  captureStep: number | null;
  /** joint1 the capture of this pause sees. */
  j1: number;
}

/** The whole sweep timeline, with the bridge's durations (~15 s). The last keyframe is the return home. */
export function sweepTimeline(): { keyframes: SweepKeyframe[]; totalMs: number } {
  const positions = sweepPositions();
  const survey = Object.fromEntries(SURVEY_POSE.map(([id, p]) => [String(id), p]));
  const keyframes: SweepKeyframe[] = [];
  let t = 0;
  positions.forEach((j1, i) => {
    const moveMs = i === 0 ? SURVEY_MOVE_MS : STEP_MOVE_MS;
    // The capture of this pause happens once the arm has settled
    keyframes.push({ atMs: t, moveMs, servos: { ...survey, '1': j1 }, captureStep: null, j1 });
    t += moveMs + SETTLE_MS;
    keyframes.push({ atMs: t, moveMs: 0, servos: {}, captureStep: i + 1, j1 });
  });
  keyframes.push({
    atMs: t,
    moveMs: HOME_MOVE_MS,
    servos: { '1': 500, ...Object.fromEntries(HOME_POSE.map(([id, p]) => [String(id), p])) },
    captureStep: null,
    j1: 500,
  });
  return { keyframes, totalMs: t + HOME_MOVE_MS };
}
