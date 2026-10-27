import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { caseSwitchAction } from '../gatekeeper-case.ts';

describe('caseSwitchAction', () => {
  it('puts the key back in the gripper with the mock bridge', () => {
    assert.equal(caseSwitchAction(true, 'mock', 'released_approved'), 'hold');
  });

  it('puts the key back in the gripper in the twin-only simulation', () => {
    assert.equal(caseSwitchAction(false, undefined, 'released_rejected'), 'hold');
  });

  it('only asks for the key with the real robot', () => {
    assert.equal(caseSwitchAction(true, 'stm32-board (/dev/rrc @ 1Mbps)', 'released_approved'), 'hint');
  });

  it('does nothing with the real robot when the key is still held', () => {
    assert.equal(caseSwitchAction(true, 'ros2-topics', 'deploy_key'), 'none');
  });
});
