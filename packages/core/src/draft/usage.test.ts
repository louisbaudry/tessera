import { describe, expect, it } from 'vitest';

import { DRAFT_ENGINES } from './engine.js';
import { AI_USAGE_UNITS, usageUnit } from './usage.js';

describe('usageUnit', () => {
  it('counts DeepL in characters and the model engine in tokens', () => {
    expect(usageUnit('deepl')).toBe('characters');
    expect(usageUnit('tessera')).toBe('tokens');
  });

  it('names a known unit for every engine', () => {
    for (const engine of DRAFT_ENGINES)
      expect(AI_USAGE_UNITS).toContain(usageUnit(engine));
  });
});
