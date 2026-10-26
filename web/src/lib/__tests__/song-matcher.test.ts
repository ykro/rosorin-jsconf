import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { matchSongsForPrompt, type SongClip } from '../song-matcher.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const catalog = JSON.parse(readFileSync(here('../../../public/songs/catalog.json'), 'utf8')) as SongClip[];

describe('song-matcher', () => {
  it('only hardcodes clip ids that exist in catalog.json', () => {
    const src = readFileSync(here('../song-matcher.ts'), 'utf8');
    const ids = [...src.matchAll(/pickById\('([^']+)'\)/g)].map((m) => m[1]);
    assert.ok(ids.length > 20);
    const known = new Set(catalog.map((c) => c.id));
    const missing = ids.filter((id) => !known.has(id));
    assert.deepEqual(missing, []);
  });

  it('answers every stage prompt with exactly one clip from the catalog', () => {
    const state = { recentClipIds: [] as string[] };
    for (const prompt of [
      '¡Hola Bumblebee! ¿Cómo estás hoy?',
      'El deploy en viernes salió perfecto a la primera.',
      'Se cayó producción y nadie sabe por qué.',
      'Baila con las llantas Mecanum y los 6 ejes.',
      'algo completamente distinto',
    ]) {
      const match = matchSongsForPrompt(catalog, prompt, state);
      assert.equal(match.clips.length, 1);
      assert.ok(catalog.includes(match.clips[0]));
    }
  });
});
