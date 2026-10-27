import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apiKeyGateState, missingKeyNotice } from '../api-key-gate.ts';

describe('apiKeyGateState', () => {
  it('shows the interaction as soon as there is a key, typed or from the bridge', () => {
    for (const status of ['idle', 'loading', 'configured', 'missing', 'unreachable', 'disabled'] as const) {
      assert.equal(apiKeyGateState('manual', status), 'ready');
      assert.equal(apiKeyGateState('bridge', status), 'ready');
    }
  });

  it('waits while the bridge is still being asked, instead of flashing the prompt', () => {
    assert.equal(apiKeyGateState('none', 'idle'), 'loading');
    assert.equal(apiKeyGateState('none', 'loading'), 'loading');
  });

  it('asks for the key once the bridge answered without one or could not be asked', () => {
    for (const status of ['missing', 'unreachable', 'disabled', 'configured'] as const) {
      assert.equal(apiKeyGateState('none', status), 'prompt');
    }
  });
});

describe('missingKeyNotice', () => {
  it('never mentions a host or IP, nor that the key is not stored', () => {
    for (const status of ['idle', 'loading', 'configured', 'missing', 'unreachable', 'disabled'] as const) {
      const text = missingKeyNotice(status);
      assert.doesNotMatch(text, /\d+\.\d+\.\d+\.\d+|localhost|:\d{2,5}/, status);
      assert.doesNotMatch(text, /no se guarda|esta página está abierta/i, status);
      assert.ok(text.length > 0);
    }
  });

  it('says why the key is missing', () => {
    assert.match(missingKeyNotice('unreachable'), /no responde/);
    assert.match(missingKeyNotice('missing'), /GEMINI_API_KEY en web\/\.env/);
    assert.match(missingKeyNotice('loading'), /Buscando/);
    assert.equal(missingKeyNotice('disabled'), 'Ingresa tu API key de Gemini para empezar.');
  });
});
