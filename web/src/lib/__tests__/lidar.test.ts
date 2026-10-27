import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSectorUncovered } from '../lidar.ts';

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
