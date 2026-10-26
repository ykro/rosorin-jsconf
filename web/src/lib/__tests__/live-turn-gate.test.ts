import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TurnAudioGate } from '../live-turn-gate.ts';

describe('TurnAudioGate (barge-in)', () => {
  it('plays audio normally when nobody interrupts', () => {
    const gate = new TurnAudioGate();
    assert.equal(gate.acceptAudioChunk(), true);
    assert.equal(gate.acceptAudioChunk(), true);
    gate.onTurnComplete();
    assert.equal(gate.acceptAudioChunk(), true);
  });

  it('drops the rest of a generation interrupted while the server is streaming', () => {
    const gate = new TurnAudioGate();
    assert.equal(gate.acceptAudioChunk(), true);
    gate.interrupt();
    assert.equal(gate.acceptAudioChunk(), false);
    gate.onServerInterrupted();
    // The next response must be audible again.
    assert.equal(gate.acceptAudioChunk(), true);
  });

  it('does not mute the next response when the interruption happens after turnComplete (regression)', () => {
    const gate = new TurnAudioGate();
    gate.acceptAudioChunk();
    gate.acceptAudioChunk();
    gate.onTurnComplete(); // server finished, local queue still playing
    gate.interrupt(); // user barges in over the queued audio
    assert.equal(gate.acceptAudioChunk(), true, 'next answer must play');
  });

  it('recovers via turnComplete when the server never sends interrupted (Interrumpir button)', () => {
    const gate = new TurnAudioGate();
    gate.acceptAudioChunk();
    gate.interrupt();
    assert.equal(gate.acceptAudioChunk(), false);
    gate.onTurnComplete();
    assert.equal(gate.acceptAudioChunk(), true);
  });

  it('reset() clears a pending discard for a new session', () => {
    const gate = new TurnAudioGate();
    gate.acceptAudioChunk();
    gate.interrupt();
    gate.reset();
    assert.equal(gate.acceptAudioChunk(), true);
  });
});
