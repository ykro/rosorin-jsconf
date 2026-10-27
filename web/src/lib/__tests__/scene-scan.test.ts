import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROP_LAYOUT,
  aimFromResponse,
  describeAim,
  detectionToWorld,
  formatBearing,
  propPlacements,
  scanProgress,
  scanResultRows,
} from '../scene-scan.ts';
import { executedMessage } from '../robot-client.ts';
import type { ScanEnvStatus, SceneDetection } from '../types.ts';

const idle: ScanEnvStatus = {
  state: 'idle',
  scene: null,
  step: 0,
  steps: 11,
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

function det(id: SceneDetection['id'], x: number, y: number, confidence = 0.9): SceneDetection {
  return {
    id,
    label: id,
    x_m: x,
    y_m: y,
    z_m: -0.025,
    bearing_deg: (Math.atan2(y, x) * 180) / Math.PI,
    distance_m: Math.hypot(x, y),
    confidence,
    views: 3,
    method: 'mock',
    lidar_confirmed: null,
    joint1_target: 500,
  };
}

const done: ScanEnvStatus = {
  ...idle,
  state: 'done',
  scene: 'gatekeeper',
  step: 11,
  finished_at_ms: 1,
  detections: [det('approve_tray', 0.22, -0.15), det('reject_tray', 0.17, 0.2, 0.3)],
  odom_at_scan: { x_m: 0, y_m: 0, yaw_rad: 0 },
  fresh: true,
  stale_reason: null,
};

describe('propPlacements', () => {
  it('uses the fixed layout without a finished scan', () => {
    for (const scan of [undefined, idle, { ...done, state: 'running' as const }, { ...done, state: 'aborted' as const }]) {
      const p = propPlacements(scan);
      assert.deepEqual({ x: p.approve_tray.x, y: p.approve_tray.y }, DEFAULT_PROP_LAYOUT.approve_tray);
      assert.equal(p.approve_tray.measured, false);
    }
  });

  it('moves the measured props and keeps the others fixed', () => {
    const p = propPlacements(done);
    assert.deepEqual(p.approve_tray, { x: 0.22, y: -0.15, measured: true });
    assert.equal(p.reject_tray.measured, true);
    assert.deepEqual(p.cloud_run, { ...DEFAULT_PROP_LAYOUT.cloud_run, measured: false });
  });

  it('places detections in the world frame of the scan pose', () => {
    const w = detectionToWorld({ x_m: 0.2, y_m: 0 }, { x_m: 1, y_m: 2, yaw_rad: Math.PI / 2 });
    assert.ok(Math.abs(w.x - 1) < 1e-9 && Math.abs(w.y - 2.2) < 1e-9);
    // Still drawn where it is after the robot moved (stale for aiming, not for drawing)
    assert.equal(propPlacements({ ...done, fresh: false, stale_reason: 'moved' }).approve_tray.measured, true);
  });
});

describe('scanProgress and rows', () => {
  it('shows the step while running', () => {
    const p = scanProgress({ ...idle, state: 'running', scene: 'gatekeeper', step: 3 }, 'gatekeeper');
    assert.equal(p.label, 'Paso 3/11');
    assert.equal(p.running, true);
    assert.ok(Math.abs(p.fraction - 3 / 11) < 1e-9);
    assert.equal(scanProgress({ ...idle, state: 'running', step: 0 }, 'gatekeeper').label, 'Preparando el brazo…');
  });

  it('explains an abort and a stale result', () => {
    const aborted = scanProgress({ ...idle, state: 'aborted', step: 4, reason: 'estop' }, 'gatekeeper');
    assert.equal(aborted.label, 'Abortado');
    assert.match(aborted.detail ?? '', /STOP/);
    const stale = scanProgress({ ...done, fresh: false, stale_reason: 'moved' }, 'gatekeeper');
    assert.match(stale.detail ?? '', /se movió.*lado fijo/);
    assert.equal(scanProgress(done, 'gatekeeper').label, 'Listo · 2/2 encontrados');
    assert.equal(scanProgress(done, 'bughunter').label, 'Reconocido otro escenario');
  });

  it('lists every prop of the scene, flagging low confidence', () => {
    const rows = scanResultRows(done, 'gatekeeper');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].found, true);
    assert.match(rows[0].text, /34° der · 0\.27 m · 90 %/);
    assert.equal(rows[1].lowConfidence, true);
    const totems = scanResultRows(done, 'bughunter');
    assert.equal(totems.length, 3);
    assert.ok(totems.every((r) => !r.found && r.text === '—'));
  });

  it('formats bearings REP-103 (+ = left)', () => {
    assert.equal(formatBearing(31.4), '31° izq');
    assert.equal(formatBearing(-12.6), '13° der');
    assert.equal(formatBearing(0.2), 'al frente');
    assert.equal(formatBearing(null), '—');
  });
});

describe('gesture aim', () => {
  it('reads the aim of a /gesture response and describes it', () => {
    const measured = aimFromResponse({
      status: 'ok',
      aim: { source: 'measured', object: 'approve_tray', joint1: 340, bearing_deg: -34.3, distance_m: 0.266, confidence: 0.9, reason: null },
    });
    assert.ok(measured);
    assert.match(describeAim(measured), /posición medida de Bandeja APROBADO.*34° der, 0\.27 m/);
    const fixed = aimFromResponse({ aim: { source: 'default', object: 'firestore', joint1: 390, bearing_deg: null, distance_m: null, confidence: null, reason: 'no_scan' } });
    assert.ok(fixed);
    assert.match(describeAim(fixed), /lado fijo de Tótem Firestore.*no_scan/);
    assert.equal(aimFromResponse({ status: 'ok' }), null);
    assert.equal(aimFromResponse({ aim: { source: 'guess', object: 'x' } }), null);
    assert.equal(aimFromResponse(null), null);
  });

  it('tells the model which target the robot used', () => {
    assert.equal(executedMessage(null), 'Ejecutado en el robot.');
    assert.equal(executedMessage({ telemetry: null, aim: null }), 'Ejecutado en el robot.');
    const msg = executedMessage({
      telemetry: null,
      aim: { source: 'measured', object: 'cloud_run', joint1: 600, bearing_deg: 20, distance_m: 0.4, confidence: 0.8, reason: null },
    });
    assert.match(msg, /^Ejecutado en el robot\. Apuntó a la posición medida de Tótem Cloud Run/);
  });
});
