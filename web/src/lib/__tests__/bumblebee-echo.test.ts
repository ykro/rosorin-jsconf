import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EchoGate, isLyricEcho } from '../bumblebee-echo.ts';

const FRAME_MS = 43;

/** Feeds `n` frames of the same RMS starting at `t`; returns the decisions and the end time. */
function feed(gate: EchoGate, rms: number, n: number, t: number) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(gate.onFrame(rms, FRAME_MS, t));
    t += FRAME_MS;
  }
  return { out, t };
}

describe('EchoGate: half-duplex while a clip plays', () => {
  it('never streams during playback and for the tail after it', () => {
    const gate = new EchoGate();
    let t = 1000;
    gate.startPlayback(t);
    let r = feed(gate, 0.05, 40, t); // the song as heard by the mic
    assert.ok(r.out.every((d) => !d.send && !d.bargeIn));
    t = r.t;
    gate.endPlayback(t);
    r = feed(gate, 0.05, 10, t); // 430 ms of tail: still closed
    assert.ok(r.out.every((d) => !d.send));
    r = feed(gate, 0.002, 15, r.t); // past the 900 ms tail
    assert.equal(gate.state, 'open');
    assert.ok(r.out.at(-1)!.send);
  });

  it('a song echo, however loud, is not a barge-in', () => {
    const gate = new EchoGate();
    gate.startPlayback(0);
    const r = feed(gate, 0.12, 120, 0); // ~5 s of loud echo
    assert.ok(r.out.every((d) => !d.bargeIn));
    assert.ok(gate.echoLevel > 0.1);
  });

  it('the user talking clearly over the echo is a barge-in after ~280 ms, and the gate reopens', () => {
    const gate = new EchoGate();
    let { t } = feed(gate, 0.003, 10, 0); // room noise floor
    gate.startPlayback(t);
    ({ t } = feed(gate, 0.02, 20, t)); // echo after AEC
    const r = feed(gate, 0.12, 10, t); // user speech, 6x the echo
    const firstBarge = r.out.findIndex((d) => d.bargeIn);
    assert.ok(firstBarge >= 6 && firstBarge <= 7, `barge-in at frame ${firstBarge}`);
    assert.equal(r.out.filter((d) => d.bargeIn).length, 1, 'fires once');
    assert.ok(r.out[firstBarge].send && r.out[firstBarge].userSpeech);
    assert.equal(gate.state, 'open');
    assert.ok(r.out.slice(firstBarge + 1).every((d) => d.send));
  });

  it('a short burst (a clap, a cough) is not a barge-in', () => {
    const gate = new EchoGate();
    gate.startPlayback(0);
    let { t } = feed(gate, 0.02, 20, 0);
    for (let i = 0; i < 5; i++) {
      ({ t } = feed(gate, 0.2, 3, t)); // 129 ms loud
      ({ t } = feed(gate, 0.02, 4, t));
    }
    assert.equal(gate.state, 'playing');
  });

  it('no barge-in during the warm-up at the start of a clip', () => {
    const gate = new EchoGate();
    gate.startPlayback(0);
    const r = feed(gate, 0.2, 8, 0); // 344 ms, inside the 350 ms warm-up
    assert.ok(r.out.every((d) => !d.bargeIn));
  });

  it('endPlayback(immediate) reopens at once (manual interruption)', () => {
    const gate = new EchoGate();
    gate.startPlayback(0);
    feed(gate, 0.05, 10, 0);
    gate.endPlayback(500, true);
    assert.equal(gate.state, 'open');
    assert.ok(gate.onFrame(0.05, FRAME_MS, 501).send);
  });

  it('while open, sustained speech fires userSpeech once per utterance', () => {
    const gate = new EchoGate();
    let { t } = feed(gate, 0.003, 10, 0);
    let r = feed(gate, 0.06, 10, t);
    assert.equal(r.out.filter((d) => d.userSpeech).length, 1);
    ({ t } = feed(gate, 0.003, 5, r.t)); // pause
    r = feed(gate, 0.06, 10, t);
    assert.equal(r.out.filter((d) => d.userSpeech).length, 1, 'a new utterance fires again');
  });
});

describe('isLyricEcho: the mic transcribing the song', () => {
  const lyrics = ["It's me, hi, I'm the problem, it's me", 'Never gonna give you up'];

  it('matches the playing lyric, case and punctuation aside', () => {
    assert.equal(isLyricEcho("I'm the problem it's me", lyrics), true);
    assert.equal(isLyricEcho('never gonna give', lyrics), true);
  });

  it('does not match what the user actually says', () => {
    assert.equal(isLyricEcho('Se cayó producción y nadie sabe por qué', lyrics), false);
    assert.equal(isLyricEcho('who is the problem here robot', lyrics), false);
  });

  it('needs two words and some lyrics', () => {
    assert.equal(isLyricEcho('problem', lyrics), false);
    assert.equal(isLyricEcho('never gonna', []), false);
  });

  it('ignores accents', () => {
    assert.equal(isLyricEcho('la bamba para bailar', ['Para bailar la bamba se necesita']), true);
    assert.equal(isLyricEcho('tú me haces bien', ['Tu me haces bien, muy bien']), true);
  });
});
