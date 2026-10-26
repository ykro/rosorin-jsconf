import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepoSlug, analyzeGithubRepo } from '../repo-analyzer.ts';
import {
  downsampleFloat32ToInt16_16kHz,
  int16ToBase64,
} from '../audio-worklet.ts';

describe('repo-analyzer', () => {
  it('normalizes full GitHub URLs and owner/repo slugs', () => {
    assert.equal(
      normalizeRepoSlug('https://github.com/ykro/pupper-talk/'),
      'ykro/pupper-talk'
    );
    assert.equal(
      normalizeRepoSlug('https://github.com/Hiwonder/ROSOrin-Pro.git'),
      'Hiwonder/ROSOrin-Pro'
    );
  });

  it('returns deterministic rehearsal analysis for preset repositories', async () => {
    const res = await analyzeGithubRepo('legacy-js/todo-400-deps');
    assert.equal(res.suggestedGesture, 'trash_toss');
    assert.equal(res.dependencyCount, 412);
    assert.ok(res.roastScore < 30);
  });
});

describe('audio-worklet PCM utilities', () => {
  it('downsamples 48kHz Float32 audio to 16kHz Int16 PCM accurately', () => {
    const input48k = new Float32Array(480);
    input48k.fill(0.5);
    const pcm16k = downsampleFloat32ToInt16_16kHz(input48k, 48000);
    assert.equal(pcm16k.length, 160);
    assert.ok(Math.abs(pcm16k[0] - 16383) <= 2);
  });

  it('encodes Int16 PCM buffer to valid base64', () => {
    const samples = new Int16Array([0, 16383, -16384]);
    const b64 = int16ToBase64(samples);
    assert.equal(typeof b64, 'string');
    assert.ok(b64.length > 0);
    const decoded = Buffer.from(b64, 'base64');
    assert.equal(decoded.byteLength, samples.byteLength);
  });
});
