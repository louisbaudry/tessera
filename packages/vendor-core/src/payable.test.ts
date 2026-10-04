import { describe, expect, it } from 'vitest';

import { computePayable, tierForOrigin } from './payable.js';

describe('tierForOrigin', () => {
  it('reads exact, repetitions and ICE', () => {
    expect(tierForOrigin('tm_exact')).toBe('exact');
    expect(tierForOrigin('tm_exact_tagdiff')).toBe('exact');
    expect(tierForOrigin('propagated')).toBe('exact');
    expect(tierForOrigin('tm_ice')).toBe('ice');
  });
  it('puts a fuzzy percentage in its band, and below 50 in none', () => {
    const t = (p: number) => tierForOrigin(`tm_fuzzy_${p}`);
    expect([t(99), t(95), t(94), t(85), t(84), t(75), t(74), t(50), t(49)]).toEqual([
      'fuzzy_95_99',
      'fuzzy_95_99',
      'fuzzy_85_94',
      'fuzzy_85_94',
      'fuzzy_75_84',
      'fuzzy_75_84',
      'fuzzy_50_74',
      'fuzzy_50_74',
      'no_match',
    ]);
  });
  it('is no match for a null, a human or an unknown origin', () => {
    expect(tierForOrigin(null)).toBe('no_match');
    expect(tierForOrigin('human')).toBe('no_match');
    expect(tierForOrigin('tm_fuzzy_100')).toBe('no_match');
  });
});

describe('computePayable', () => {
  it('multiplies words by the tier rate and sums, in tier order', () => {
    const p = computePayable(
      { exact: 200, no_match: 1000, fuzzy_85_94: 50 },
      { no_match: 80_000, fuzzy_85_94: 40_000, exact: 8_000 },
    );
    expect(p.lines.map((l) => l.tier)).toEqual(['no_match', 'fuzzy_85_94', 'exact']);
    expect(p.totalMicros).toBe(1000 * 80_000 + 50 * 40_000 + 200 * 8_000);
    expect(p.words).toBe(1250);
    expect(p.unpriced).toEqual([]);
  });
  it('never prices a tier with no rate at zero: it names it', () => {
    const p = computePayable({ no_match: 10, ice: 5 }, { no_match: 100_000 });
    expect(p.totalMicros).toBe(1_000_000);
    expect(p.unpriced).toEqual(['ice']);
    expect(p.lines.find((l) => l.tier === 'ice')).toMatchObject({
      rateMicros: null,
      amountMicros: 0,
    });
  });
  it('treats a rate of 0 as a rate: a free repetition is priced, not unpriced', () => {
    const p = computePayable({ exact: 30 }, { exact: 0 });
    expect(p.unpriced).toEqual([]);
    expect(p.totalMicros).toBe(0);
  });
  it('is empty for no words, and refuses fractional or negative input', () => {
    expect(computePayable({}, {})).toMatchObject({ totalMicros: 0, words: 0, lines: [] });
    expect(() => computePayable({ exact: 1.5 }, { exact: 1 })).toThrow(RangeError);
    expect(() => computePayable({ exact: -1 }, { exact: 1 })).toThrow(RangeError);
    expect(() => computePayable({ exact: 1 }, { exact: -1 })).toThrow(RangeError);
  });
});
