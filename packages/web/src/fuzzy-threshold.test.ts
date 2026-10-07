import { describe, expect, it } from 'vitest';

import { thresholdChoice, thresholdText } from './fuzzy-threshold.js';

const range = { min: 50, max: 99 };

describe('thresholdChoice', () => {
  it('takes a whole number in range', () => {
    expect(thresholdChoice('90', false, range)).toEqual({ ok: true, choice: 90 });
    expect(thresholdChoice(' 50 ', false, range)).toEqual({ ok: true, choice: 50 });
    expect(thresholdChoice('99', false, range)).toEqual({ ok: true, choice: 99 });
  });

  it('is off when off is checked, whatever the field says', () => {
    expect(thresholdChoice('90', true, range)).toEqual({ ok: true, choice: null });
    expect(thresholdChoice('nonsense', true, range)).toEqual({ ok: true, choice: null });
  });

  it('is the default again when the field is empty', () => {
    expect(thresholdChoice('', false, range)).toEqual({ ok: true, choice: 'default' });
    expect(thresholdChoice('   ', false, range)).toEqual({ ok: true, choice: 'default' });
  });

  it('refuses a number out of range, a half score and words, naming the range', () => {
    for (const bad of ['49', '100', '80.5', 'high', '-5']) {
      const r = thresholdChoice(bad, false, range);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.message).toContain('50 to 99');
    }
  });

  it('uses the range it is given, not one of its own', () => {
    expect(thresholdChoice('60', false, { min: 70, max: 80 }).ok).toBe(false);
  });
});

describe('thresholdText', () => {
  it('shows the score, and nothing when off', () => {
    expect(thresholdText({ threshold: 75 })).toBe('75');
    expect(thresholdText({ threshold: null })).toBe('');
  });
});
