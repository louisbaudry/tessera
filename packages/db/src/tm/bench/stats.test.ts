import { describe, expect, it } from 'vitest';

import { fuzzyScore, mcnemarOneSided, words } from './stats.ts';

describe('fuzzyScore', () => {
  const row = new Int32Array(64);

  it('scores interned ids exactly as it scores the words they stand for', () => {
    const a = words('The council shall adopt the measures');
    const b = words('the Council adopted these measures quickly');
    const ids = new Map<string, number>();
    const intern = (ws: string[]) =>
      Int32Array.from(ws, (w) => ids.get(w) ?? (ids.set(w, ids.size), ids.size - 1));
    expect(fuzzyScore(intern(a), intern(b), row)).toBe(fuzzyScore(a, b, row));
    expect(fuzzyScore(a, b, row)).toBeCloseTo(1 - 4 / 6, 12);
  });
});

describe('mcnemarOneSided', () => {
  it('is 1 with no discordant pairs', () => {
    expect(mcnemarOneSided(0, 0)).toBe(1);
  });

  it('matches the binomial tail', () => {
    // P(X >= 8), X ~ Bin(10, 1/2) = (45 + 10 + 1) / 1024.
    expect(mcnemarOneSided(8, 2)).toBeCloseTo(56 / 1024, 12);
    // All discordant pairs one way: 2^-n.
    expect(mcnemarOneSided(12, 0)).toBeCloseTo(2 ** -12, 15);
    // None the tested way: certainty.
    expect(mcnemarOneSided(0, 7)).toBeCloseTo(1, 12);
  });

  it('stays finite for large counts', () => {
    const p = mcnemarOneSided(230, 170);
    expect(p).toBeGreaterThan(0.001);
    expect(p).toBeLessThan(0.002);
  });
});
