import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSectorUncovered, lidarAlert, lidarMarkers } from '../lidar.ts';

const base = { front_m: 1, left_m: 1, right_m: 1, back_m: 0, obstacle_alert: false };

describe('isSectorUncovered', () => {
  it('is true only for sectors listed in uncovered', () => {
    const lidar = { ...base, uncovered: ['back' as const] };
    assert.equal(isSectorUncovered(lidar, 'back'), true);
    assert.equal(isSectorUncovered(lidar, 'front'), false);
  });

  it('is false for older bridges and mock (no uncovered field)', () => {
    assert.equal(isSectorUncovered(base, 'back'), false);
    assert.equal(isSectorUncovered(undefined, 'back'), false);
  });
});

describe('lidarMarkers', () => {
  const open = { front_m: 4, left_m: 4, right_m: 4, back_m: 4, obstacle_alert: false };

  it('draws nothing for an open stage', () => {
    assert.deepEqual(lidarMarkers(open), []);
    assert.equal(lidarAlert(open), false);
  });

  it('puts each echo on its own side of the robot', () => {
    const markers = lidarMarkers({ ...open, left_m: 0.5, right_m: 0.2 });
    assert.deepEqual(
      markers.map((m) => [m.sector, m.kind, m.distanceM, m.braking]),
      [
        ['left', 'echo', 0.5, false],
        ['right', 'echo', 0.2, true],
      ]
    );
    assert.equal(markers[0].angleRad, Math.PI / 2);
    assert.equal(markers[1].angleRad, -Math.PI / 2);
  });

  it('never draws an uncovered sector, even though it reads 0.0', () => {
    const lidar = { ...open, back_m: 0, uncovered: ['back' as const] };
    assert.deepEqual(lidarMarkers(lidar), []);
    assert.equal(lidarAlert(lidar), false);
  });

  it('shows a covered sector at 0.0 as blind, not as an echo', () => {
    const [m] = lidarMarkers({ ...open, front_m: 0 });
    assert.equal(m.sector, 'front');
    assert.equal(m.kind, 'blind');
    assert.equal(lidarAlert({ ...open, front_m: 0 }), true);
  });
});
