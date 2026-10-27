import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AIM_J1_MAX,
  AIM_J1_MIN,
  DEFAULT_SIM_SCENE,
  SCAN_STEPS,
  aggregate,
  aimFor,
  aimSteps,
  joint1ForPoint,
  refreshScan,
  runningScan,
  simCapture,
  sweepPositions,
  sweepTimeline,
  type CaptureDetection,
} from '../scene-scan-sim.ts';
import { GESTURES } from '../gesture-choreographies.generated.ts';
import type { ScanEnvStatus, ScanScene } from '../types.ts';

const origin = { x_m: 0, y_m: 0, yaw_rad: 0 };

/** Runs the whole simulated sweep from `odom` and returns the finished status (as the hook does). */
function simulate(scene: ScanScene, odom = origin, now = 1_000): ScanEnvStatus {
  const captures: CaptureDetection[][] = sweepPositions().map((j1) => simCapture(scene, DEFAULT_SIM_SCENE, odom, j1));
  return refreshScan(
    {
      ...runningScan(scene, now),
      state: 'done',
      finished_at_ms: now,
      detections: aggregate(scene, captures),
      odom_at_scan: odom,
      stale_reason: null,
    },
    odom,
    now
  );
}

describe('scene-scan-sim: same sweep as the bridge', () => {
  it('sweeps joint1 280 → 720 in 11 pauses and lasts ~15 s', () => {
    const pos = sweepPositions();
    assert.equal(pos.length, SCAN_STEPS);
    assert.equal(pos[0], 280);
    assert.equal(pos[SCAN_STEPS - 1], 720);
    assert.deepEqual(pos.slice(0, 3), [280, 324, 368]);
    const { keyframes, totalMs } = sweepTimeline();
    assert.equal(keyframes.filter((k) => k.captureStep !== null).length, SCAN_STEPS);
    // 1500 + 500 (survey) + 10 × (600 + 500) + 1500 home
    assert.equal(totalMs, 1500 + 500 + 10 * 1100 + 1500);
    // Only servos 1-4 move; 5 and 10 (the held key) are never touched
    for (const k of keyframes) for (const id of Object.keys(k.servos)) assert.ok(['1', '2', '3', '4'].includes(id), id);
  });
});

describe('scene-scan-sim: the simulated camera only sees what its cone covers', () => {
  it('sees the APROBADO tray (right) when joint1 points right, not when it points left', () => {
    const right = simCapture('gatekeeper', DEFAULT_SIM_SCENE, origin, 280).map((d) => d.id);
    const left = simCapture('gatekeeper', DEFAULT_SIM_SCENE, origin, 720).map((d) => d.id);
    assert.ok(right.includes('approve_tray'));
    assert.ok(!left.includes('approve_tray'));
    assert.ok(left.includes('reject_tray'));
    assert.ok(!right.includes('reject_tray'));
  });

  it('only looks for the props of its own demo', () => {
    const ids = sweepPositions().flatMap((j1) => simCapture('gatekeeper', DEFAULT_SIM_SCENE, origin, j1).map((d) => d.id));
    assert.ok(ids.every((id) => id === 'approve_tray' || id === 'reject_tray'));
  });

  it('confidence drops toward the edge of the image', () => {
    const scene = [{ id: 'approve_tray' as const, x_m: 0.3, y_m: 0 }];
    const center = simCapture('gatekeeper', scene, origin, 500)[0];
    const edge = simCapture('gatekeeper', scene, origin, 610)[0]; // ~26° off-center
    assert.ok(center.confidence > edge.confidence);
    assert.equal(simCapture('gatekeeper', scene, origin, 720).length, 0); // 53° off: outside ±34°
  });

  it('ignores props closer than 8 cm or farther than 90 cm from the joint1 axis', () => {
    const near = [{ id: 'approve_tray' as const, x_m: 0.08, y_m: 0 }];
    const far = [{ id: 'approve_tray' as const, x_m: 1.2, y_m: 0 }];
    assert.equal(simCapture('gatekeeper', near, origin, 500).length, 0);
    assert.equal(simCapture('gatekeeper', far, origin, 500).length, 0);
  });
});

describe('scene-scan-sim: a full sweep finds the simulated stage', () => {
  it('Demo B: both trays at their simulated positions, the gestures aim at them', () => {
    const scan = simulate('gatekeeper');
    assert.equal(scan.fresh, true);
    const approve = scan.detections.find((d) => d.id === 'approve_tray')!;
    const reject = scan.detections.find((d) => d.id === 'reject_tray')!;
    assert.ok(Math.abs(approve.x_m - 0.22) < 1e-3 && Math.abs(approve.y_m + 0.15) < 1e-3);
    assert.ok(approve.bearing_deg < 0, 'APROBADO is on the right in the simulated stage');
    assert.ok(reject.bearing_deg > 0, 'RECHAZADO is on the left');
    assert.ok(approve.views >= 2 && approve.confidence > 0.45);
    // Same joint1 the bridge's mock reached end to end (330 for APROBADO on the right)
    assert.ok(Math.abs(approve.joint1_target - 330) <= 2, String(approve.joint1_target));
    assert.ok(reject.joint1_target > 500);
  });

  it('Demo C: the three totems', () => {
    const ids = simulate('bughunter').detections.map((d) => d.id).sort();
    assert.deepEqual(ids, ['cloud_run', 'firestore', 'gemini_live']);
  });

  it('works from a rotated robot: positions stay in the robot frame at scan time', () => {
    const odom = { x_m: 0.1, y_m: 0, yaw_rad: 0.2 };
    const scan = simulate('gatekeeper', odom);
    const aim = aimFor(scan, 'approve_tray', odom, 2_000);
    assert.ok(aim.ok);
  });
});

describe('scene-scan-sim: aiming like aim_for / joint1_for_point', () => {
  it('maps a bearing to joint1 (> 500 = left) and clamps to 250-750', () => {
    assert.equal(joint1ForPoint(0.3, 0), 500);
    assert.ok(joint1ForPoint(0.2, 0.2) > 500);
    assert.ok(joint1ForPoint(0.2, -0.2) < 500);
    assert.equal(joint1ForPoint(0.05, 0.5), AIM_J1_MAX);
    assert.equal(joint1ForPoint(0.05, -0.5), AIM_J1_MIN);
  });

  it('without a scan, or after the robot moved or the scan expired, the gesture keeps its fixed side', () => {
    const idle = runningScan('gatekeeper', 0);
    assert.deepEqual(aimFor({ ...idle, state: 'idle', stale_reason: 'no_scan' }, 'approve_tray', origin, 0), {
      ok: false,
      reason: 'no_scan',
    });
    assert.deepEqual(aimFor(idle, 'approve_tray', origin, 0), { ok: false, reason: 'running' });
    const scan = simulate('gatekeeper');
    assert.deepEqual(aimFor(scan, 'approve_tray', { x_m: 0.3, y_m: 0, yaw_rad: 0 }, 2_000), { ok: false, reason: 'moved' });
    assert.deepEqual(aimFor(scan, 'approve_tray', origin, 1_000 + 16 * 60 * 1000), { ok: false, reason: 'expired' });
    assert.deepEqual(aimFor(scan, 'cloud_run', origin, 2_000), { ok: false, reason: 'not_found' });
    // A small move (reject's back-off) is corrected by the odometry and still aims
    const nudged = aimFor(scan, 'approve_tray', { x_m: -0.05, y_m: 0, yaw_rad: 0 }, 2_000);
    assert.ok(nudged.ok && Math.abs(nudged.x_m - 0.27) < 1e-3);
  });

  it('moved is sticky: coming back does not make the scan fresh again', () => {
    const scan = simulate('gatekeeper');
    const away = refreshScan(scan, { x_m: 0.5, y_m: 0, yaw_rad: 0 }, 2_000);
    assert.equal(away.stale_reason, 'moved');
    assert.equal(refreshScan(away, origin, 3_000).fresh, false);
  });

  it('aims every step at the measured joint1 and drops the strafe/advance (reject keeps its shake and back-off)', () => {
    const approve = aimSteps('gatekeeper_approve', GESTURES.gatekeeper_approve.steps, 330);
    assert.ok(approve.every((s) => s.servos[0] === 330));
    assert.ok(approve.every((s) => s.velocity === null || (s.velocity[1] === 0 && s.velocity[2] === 0 && s.velocity[0] <= 0)));
    const original = GESTURES.gatekeeper_reject.steps;
    const reject = aimSteps('gatekeeper_reject', original, 640);
    assert.deepEqual(reject.slice(0, 2), original.slice(0, 2));
    assert.ok(reject.slice(2).every((s) => s.servos[0] === 640));
    const backOff = original.slice(2).some((s) => s.velocity && s.velocity[0] < 0);
    assert.equal(
      reject.slice(2).some((s) => s.velocity && s.velocity[0] < 0),
      backOff
    );
  });
});
