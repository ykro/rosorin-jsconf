import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_TURN_GRACE_MS, TurnAudioGate } from '../live-turn-gate.ts';

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

  describe('client turn while the server is still streaming (R3)', () => {
    it('plays the new answer after the server confirms the interruption', () => {
      const gate = new TurnAudioGate();
      assert.equal(gate.acceptAudioChunk(), true); // answer 1 streaming
      gate.interrupt(); // prepareClientTurn()
      gate.beginClientTurn(); // sendTurn()
      assert.equal(gate.acceptAudioChunk(), false, 'tail of answer 1 already in flight');
      gate.onServerInterrupted();
      assert.equal(gate.acceptAudioChunk(), true, 'answer 2 must be audible');
    });

    it('plays the new answer when the old one ends with generationComplete instead of interrupted', () => {
      const gate = new TurnAudioGate();
      gate.acceptAudioChunk();
      gate.interrupt();
      gate.beginClientTurn();
      assert.equal(gate.acceptAudioChunk(), false);
      gate.onGenerationComplete();
      assert.equal(gate.acceptAudioChunk(), true);
      gate.onTurnComplete(); // late turnComplete of answer 1 does not mute answer 2
      assert.equal(gate.acceptAudioChunk(), true);
    });

    it('never stays mute: with no end marker at all, audio is accepted again after the grace period', () => {
      let t = 1000;
      const gate = new TurnAudioGate(() => t);
      gate.acceptAudioChunk();
      gate.interrupt();
      gate.beginClientTurn();
      t += 200;
      assert.equal(gate.acceptAudioChunk(), false, 'still within the grace period: old tail');
      t += CLIENT_TURN_GRACE_MS;
      assert.equal(gate.acceptAudioChunk(), true, 'server streams the new answer directly');
      assert.equal(gate.acceptAudioChunk(), true);
    });

    it('a client turn sent while idle does not discard anything', () => {
      let t = 0;
      const gate = new TurnAudioGate(() => t);
      gate.acceptAudioChunk();
      gate.onTurnComplete();
      gate.interrupt();
      gate.beginClientTurn();
      assert.equal(gate.acceptAudioChunk(), true);
      t += 10;
      assert.equal(gate.acceptAudioChunk(), true);
    });

    it('a voice barge-in (no client turn) keeps discarding until the server ends the generation', () => {
      let t = 0;
      const gate = new TurnAudioGate(() => t);
      gate.acceptAudioChunk();
      gate.interrupt();
      t += CLIENT_TURN_GRACE_MS * 3;
      assert.equal(gate.acceptAudioChunk(), false, 'the grace period only applies to client turns');
      gate.onServerInterrupted();
      assert.equal(gate.acceptAudioChunk(), true);
    });
  });
});
