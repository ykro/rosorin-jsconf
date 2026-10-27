import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

mock.module('@google/genai', {
  namedExports: {
    Modality: { AUDIO: 'AUDIO' },
    Type: { OBJECT: 'OBJECT', STRING: 'STRING', NUMBER: 'NUMBER', ARRAY: 'ARRAY' },
    GoogleGenAI: class {},
  },
});

const { SYSTEM_PROMPT_EN, EMBODIED_TOOLS, buildEmbodiedLiveConfig } = await import('../gemini-live.ts');
const { ROASTER_PERSONA, buildRoasterSystemPrompt } = await import('../prompts/roaster.ts');

describe('Roaster system prompt', () => {
  const roaster = buildRoasterSystemPrompt(SYSTEM_PROMPT_EN);

  it('keeps the shared embodied contract verbatim and appends the persona', () => {
    assert.ok(roaster.startsWith(SYSTEM_PROMPT_EN));
    assert.ok(roaster.endsWith(ROASTER_PERSONA));
    for (const tool of ['express_verdict', 'release_deploy_key', 'point_at_service_totem', 'move_chassis']) {
      assert.ok(roaster.includes(tool), tool);
    }
    assert.ok(roaster.includes('<repo_data>'));
    assert.match(ROASTER_PERSONA, /EVERY answer/);
    assert.match(ROASTER_PERSONA, /Never attack people/);
  });

  it('the Roaster session config uses it and still declares the tools', () => {
    const config = buildEmbodiedLiveConfig(roaster);
    assert.equal(config.systemInstruction.parts[0].text, roaster);
    assert.deepEqual(config.tools, [{ functionDeclarations: EMBODIED_TOOLS }]);
  });

  it('other demos keep the shared prompt by default', () => {
    assert.equal(buildEmbodiedLiveConfig().systemInstruction.parts[0].text, SYSTEM_PROMPT_EN);
  });
});
