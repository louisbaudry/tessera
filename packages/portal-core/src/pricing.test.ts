import { describe, expect, it } from 'vitest';

import {
  estimateOrder,
  findRate,
  lineTotal,
  RateNotFoundError,
  type LanguagePairRate,
} from './pricing.js';

const RATES: readonly LanguagePairRate[] = [
  { srcLang: 'en', tgtLang: 'fr', ratePerWord: 0.12, minimumPrice: 50 },
  { srcLang: 'en', tgtLang: 'es', ratePerWord: 0.1, minimumPrice: 40 },
];

describe('findRate', () => {
  it('finds a configured pair', () => {
    expect(findRate(RATES, 'en', 'fr')).toEqual(RATES[0]);
  });

  it('throws RateNotFoundError for an unconfigured pair', () => {
    expect(() => findRate(RATES, 'en', 'de')).toThrow(RateNotFoundError);
  });
});

describe('lineTotal', () => {
  it('uses word count * rate when above the minimum', () => {
    expect(lineTotal(RATES[0]!, 1000)).toBeCloseTo(120);
  });

  it('floors at the minimum price for a small job', () => {
    expect(lineTotal(RATES[0]!, 10)).toBe(50);
  });

  it('is exactly the minimum at zero words', () => {
    expect(lineTotal(RATES[0]!, 0)).toBe(50);
  });

  it('rejects a negative word count', () => {
    expect(() => lineTotal(RATES[0]!, -5)).toThrow(RangeError);
  });
});

describe('estimateOrder', () => {
  it('sums per-target-language line totals', () => {
    const estimate = estimateOrder(RATES, 'en', ['fr', 'es'], 1000);
    expect(estimate.lines).toHaveLength(2);
    expect(estimate.lines[0]).toMatchObject({ tgtLang: 'fr', price: 120 });
    expect(estimate.lines[1]).toMatchObject({ tgtLang: 'es', price: 100 });
    expect(estimate.total).toBeCloseTo(220);
  });

  it('propagates RateNotFoundError for any missing pair', () => {
    expect(() => estimateOrder(RATES, 'en', ['fr', 'de'], 1000)).toThrow(
      RateNotFoundError,
    );
  });

  it('handles a single target language', () => {
    const estimate = estimateOrder(RATES, 'en', ['fr'], 100);
    expect(estimate.total).toBe(50); // below minimum, floored
  });
});
