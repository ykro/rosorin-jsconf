import type { GestureAim, ScanEnvStatus, ScanPropId, ScanScene, SceneDetection } from './types';

/** Props each «Reconocer» scene looks for (same as `ScanScene::objects` in scan_env.rs). */
export const SCAN_SCENE_PROPS: Record<ScanScene, ScanPropId[]> = {
  gatekeeper: ['approve_tray', 'reject_tray'],
  bughunter: ['cloud_run', 'gemini_live', 'firestore'],
};

export const PROP_LABELS: Record<ScanPropId, string> = {
  approve_tray: 'Bandeja APROBADO',
  reject_tray: 'Bandeja RECHAZADO',
  cloud_run: 'Tótem Cloud Run',
  gemini_live: 'Tótem Gemini Live',
  firestore: 'Tótem Firestore',
};

/**
 * Fixed stage layout (odometry/world frame, m, REP-103: +x forward, +y left) the twin draws when
 * there is no measurement, and the side the gestures use without one: APROBADO 18 cm to the left,
 * RECHAZADO to the right; Cloud Run left, Gemini Live center, Firestore right.
 */
export const DEFAULT_PROP_LAYOUT: Record<ScanPropId, { x: number; y: number }> = {
  approve_tray: { x: 0.18, y: 0.19 },
  reject_tray: { x: 0.18, y: -0.19 },
  cloud_run: { x: 0.34, y: 0.22 },
  gemini_live: { x: 0.34, y: 0 },
  firestore: { x: 0.34, y: -0.22 },
};

export interface PropPlacement {
  x: number;
  y: number;
  /** True when it comes from a «Reconocer» measurement, false for the fixed layout. */
  measured: boolean;
}

/** A detection (robot frame at scan time) in the odometry/world frame the twin draws in. */
export function detectionToWorld(
  d: Pick<SceneDetection, 'x_m' | 'y_m'>,
  odom: ScanEnvStatus['odom_at_scan']
): { x: number; y: number } {
  const o = odom ?? { x_m: 0, y_m: 0, yaw_rad: 0 };
  const c = Math.cos(o.yaw_rad);
  const s = Math.sin(o.yaw_rad);
  return { x: o.x_m + c * d.x_m - s * d.y_m, y: o.y_m + s * d.x_m + c * d.y_m };
}

/**
 * Where the twin should draw each prop: the measured position after a finished scan that found it
 * (even if it is no longer fresh, the world position stays valid), otherwise the fixed layout.
 */
export function propPlacements(scan: ScanEnvStatus | undefined | null): Record<ScanPropId, PropPlacement> {
  const out = {} as Record<ScanPropId, PropPlacement>;
  for (const id of Object.keys(DEFAULT_PROP_LAYOUT) as ScanPropId[]) {
    out[id] = { ...DEFAULT_PROP_LAYOUT[id], measured: false };
  }
  if (scan?.state !== 'done') return out;
  for (const d of scan.detections ?? []) {
    if (!(d.id in out) || !Number.isFinite(d.x_m) || !Number.isFinite(d.y_m)) continue;
    out[d.id] = { ...detectionToWorld(d, scan.odom_at_scan), measured: true };
  }
  return out;
}

/** «31° izq» / «12° der» / «al frente». */
export function formatBearing(deg: number | null | undefined): string {
  if (deg === null || deg === undefined || !Number.isFinite(deg)) return '—';
  const r = Math.round(deg);
  if (r === 0) return 'al frente';
  return `${Math.abs(r)}° ${r > 0 ? 'izq' : 'der'}`;
}

const ABORT_REASONS: Record<string, string> = {
  estop: 'STOP: el brazo se quedó donde estaba',
  interrupted: 'otro movimiento tomó el brazo',
  worker_dead: 'el robot dejó de responder',
};

const STALE_REASONS: Record<string, string> = {
  moved: 'el robot se movió desde el reconocimiento',
  expired: 'el reconocimiento tiene más de 15 min',
  not_found: 'no encontró ningún objeto',
};

export interface ScanProgress {
  /** «Paso 3/11», «Listo», «Abortado»… shown next to the button. */
  label: string;
  /** 0..1 */
  fraction: number;
  running: boolean;
  /** Extra line (why it was aborted / why it is not used). */
  detail: string | null;
}

export function scanProgress(scan: ScanEnvStatus | undefined | null, scene: ScanScene): ScanProgress {
  if (!scan || scan.state === 'idle') {
    return { label: 'Sin reconocer', fraction: 0, running: false, detail: null };
  }
  const steps = Math.max(1, scan.steps || 1);
  if (scan.state === 'running') {
    const step = Math.min(steps, Math.max(0, scan.step));
    return {
      label: step === 0 ? 'Preparando el brazo…' : `Paso ${step}/${steps}`,
      fraction: step / steps,
      running: true,
      detail: null,
    };
  }
  if (scan.state === 'aborted') {
    return {
      label: 'Abortado',
      fraction: Math.min(1, scan.step / steps),
      running: false,
      detail: scan.reason ? ABORT_REASONS[scan.reason] ?? scan.reason : null,
    };
  }
  if (scan.scene && scan.scene !== scene) {
    return { label: 'Reconocido otro escenario', fraction: 1, running: false, detail: 'vuelve a pulsar Reconocer aquí' };
  }
  const found = scan.detections.length;
  const failed = scan.failed_captures ? ` · ${scan.failed_captures} captura(s) sin imagen` : '';
  return {
    label: `Listo · ${found}/${SCAN_SCENE_PROPS[scene].length} encontrados`,
    fraction: 1,
    running: false,
    detail: scan.fresh
      ? failed.trim().replace(/^· /, '') || null
      : `${STALE_REASONS[scan.stale_reason ?? ''] ?? scan.stale_reason ?? ''}: los gestos usan el lado fijo${failed}`,
  };
}

/** One line per prop of the scene: found (with position) or missing. */
export function scanResultRows(scan: ScanEnvStatus | undefined | null, scene: ScanScene) {
  const done = scan?.state === 'done' && scan.scene === scene;
  return SCAN_SCENE_PROPS[scene].map((id) => {
    const d = done ? scan.detections.find((x) => x.id === id) : undefined;
    return {
      id,
      label: PROP_LABELS[id],
      found: Boolean(d),
      text: d
        ? `${formatBearing(d.bearing_deg)} · ${d.distance_m.toFixed(2)} m · ${Math.round(d.confidence * 100)} %`
        : done
          ? 'no encontrado (usa el lado fijo)'
          : '—',
      lowConfidence: d ? d.confidence < 0.45 : false,
    };
  });
}

/** Reads the `aim` field of a `/gesture` response, if it has a valid one. */
export function aimFromResponse(body: unknown): GestureAim | null {
  const aim = (body as { aim?: Partial<GestureAim> } | null)?.aim;
  if (!aim || (aim.source !== 'measured' && aim.source !== 'default') || typeof aim.object !== 'string') return null;
  return aim as GestureAim;
}

/** Spanish sentence for the UI and the Gemini tool response. */
export function describeAim(aim: GestureAim): string {
  const label = PROP_LABELS[aim.object] ?? aim.object;
  if (aim.source === 'measured') {
    const dist = aim.distance_m !== null && aim.distance_m !== undefined ? `, ${aim.distance_m.toFixed(2)} m` : '';
    return `Apuntó a la posición medida de ${label} con «Reconocer» (${formatBearing(aim.bearing_deg)}${dist}).`;
  }
  return `Apuntó al lado fijo de ${label}: no hay un «Reconocer» válido (${aim.reason ?? 'no_scan'}).`;
}
