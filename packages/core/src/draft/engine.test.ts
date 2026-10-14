import { describe, expect, it } from 'vitest';

import {
  DRAFT_ENGINES,
  ENGINE_CHOICES,
  isDraftEngine,
  isEngineChoice,
  resolveEngine,
  type ClientEngineSettings,
} from './engine.js';

const none: ClientEngineSettings = { default: 'off', consented: [] };
const tessera: ClientEngineSettings = { default: 'tessera', consented: ['tessera'] };
const both: ClientEngineSettings = {
  default: 'tessera',
  consented: ['tessera', 'deepl'],
};

describe('the engine vocabulary', () => {
  it('has off plus the engines that send client content', () => {
    expect(ENGINE_CHOICES).toEqual(['off', 'tessera', 'deepl']);
    expect(DRAFT_ENGINES).toEqual(['tessera', 'deepl']);
  });

  it('recognises only its own members', () => {
    expect(isEngineChoice('off')).toBe(true);
    expect(isEngineChoice('deepl')).toBe(true);
    expect(isEngineChoice('claude')).toBe(false);
    expect(isEngineChoice(null)).toBe(false);
    expect(isDraftEngine('tessera')).toBe(true);
    expect(isDraftEngine('off')).toBe(false);
  });
});

describe('resolveEngine — the consent gate (translation-engine-spec D4, D8)', () => {
  it('is off for a project with no client, whatever else is set', () => {
    expect(
      resolveEngine({ hasClient: false, client: both, projectOverride: 'tessera' }),
    ).toEqual({ engine: 'off', reason: 'no_client' });
  });

  it('is off for a client nobody has set anything for', () => {
    expect(
      resolveEngine({ hasClient: true, client: null, projectOverride: null }),
    ).toEqual({ engine: 'off', reason: 'client_default_off' });
    expect(
      resolveEngine({ hasClient: true, client: none, projectOverride: null }),
    ).toEqual({ engine: 'off', reason: 'client_default_off' });
  });

  it('inherits the client default when the project has no override', () => {
    expect(
      resolveEngine({ hasClient: true, client: tessera, projectOverride: null }),
    ).toEqual({ engine: 'tessera' });
  });

  it('lets a project turn the engine off', () => {
    expect(
      resolveEngine({ hasClient: true, client: tessera, projectOverride: 'off' }),
    ).toEqual({ engine: 'off', reason: 'project_off' });
  });

  it('lets a project pick another engine the client consented to', () => {
    expect(
      resolveEngine({ hasClient: true, client: both, projectOverride: 'deepl' }),
    ).toEqual({ engine: 'deepl' });
  });

  it('never widens: an override to an engine the client did not consent to is off', () => {
    expect(
      resolveEngine({ hasClient: true, client: tessera, projectOverride: 'deepl' }),
    ).toEqual({ engine: 'off', reason: 'not_consented' });
  });

  it('cannot override a client that has consented to nothing', () => {
    for (const engine of DRAFT_ENGINES) {
      expect(
        resolveEngine({ hasClient: true, client: none, projectOverride: engine }),
      ).toEqual({ engine: 'off', reason: 'not_consented' });
      expect(
        resolveEngine({ hasClient: true, client: null, projectOverride: engine }),
      ).toEqual({ engine: 'off', reason: 'not_consented' });
    }
  });

  it('refuses a default the client has not consented to, as a stale row', () => {
    // A default that outlived its consent must not send anything.
    expect(
      resolveEngine({
        hasClient: true,
        client: { default: 'deepl', consented: ['tessera'] },
        projectOverride: null,
      }),
    ).toEqual({ engine: 'off', reason: 'not_consented' });
  });
});
