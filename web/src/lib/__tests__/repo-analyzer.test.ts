import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepoSlug, analyzeGithubRepo } from '../repo-analyzer';

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
