import { describe, expect, it } from 'vitest';

import {
  billableWords,
  estimateOrder,
  FileWordCountsRequiredError,
  findRate,
  lineTotal,
  needsFileWordCounts,
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

// A per-file minimum (portal-v0-spec.md §4b): a file counts as at least
// `minWordsPerFile` words, except an empty one, which bills nothing.
const PER_FILE: LanguagePairRate = {
  srcLang: 'en',
  tgtLang: 'de',
  ratePerWord: 0.1,
  minimumPrice: 0,
  minWordsPerFile: 250,
};

describe('billableWords', () => {
  it('raises a short file to the per-file minimum', () => {
    expect(billableWords(PER_FILE, [90])).toBe(250);
  });

  it('leaves a file above the minimum as it is', () => {
    expect(billableWords(PER_FILE, [1000])).toBe(1000);
  });

  it('applies the minimum to each file, not to the order', () => {
    // Ten files of 90 words are 900 words in all, well above 250: a
    // per-order minimum would change nothing, a per-file one bills 2,500.
    expect(billableWords(PER_FILE, Array<number>(10).fill(90))).toBe(2500);
  });

  it('bills nothing for a file with no words', () => {
    expect(billableWords(PER_FILE, [0, 90])).toBe(250);
    expect(billableWords(PER_FILE, [0])).toBe(0);
  });

  it('is the plain sum when the rate has no per-file minimum', () => {
    expect(billableWords(RATES[0]!, [90, 10])).toBe(100);
    expect(billableWords({ ...PER_FILE, minWordsPerFile: 0 }, [90, 10])).toBe(100);
  });

  it('rejects a negative or non-finite file count', () => {
    expect(() => billableWords(PER_FILE, [10, -1])).toThrow(RangeError);
    expect(() => billableWords(PER_FILE, [Number.NaN])).toThrow(RangeError);
  });
});

describe('needsFileWordCounts', () => {
  it('is true only for a rate that sets a per-file minimum', () => {
    expect(needsFileWordCounts(PER_FILE)).toBe(true);
    expect(needsFileWordCounts(RATES[0]!)).toBe(false);
    expect(needsFileWordCounts({ ...PER_FILE, minWordsPerFile: 0 })).toBe(false);
  });
});

describe('estimateOrder with a count per file', () => {
  const rates = [...RATES, PER_FILE];

  it('prices each file at its own billable words', () => {
    const estimate = estimateOrder(rates, 'en', ['de'], [90, 400]);
    expect(estimate.lines[0]).toMatchObject({ tgtLang: 'de' });
    // (250 + 400) words at 0.10.
    expect(estimate.total).toBeCloseTo(65);
  });

  it('still floors the line at the pair minimum price, after the files are summed', () => {
    const withFloor: LanguagePairRate = { ...PER_FILE, minimumPrice: 100 };
    expect(estimateOrder([withFloor], 'en', ['de'], [90]).total).toBe(100);
  });

  it('prices a pair without a per-file minimum on the sum of the files', () => {
    expect(estimateOrder(rates, 'en', ['fr'], [90, 910]).total).toBeCloseTo(120);
  });

  it('mixes pairs with and without a per-file minimum in one order', () => {
    const estimate = estimateOrder(rates, 'en', ['fr', 'de'], [90, 90]);
    expect(estimate.lines.map((l) => l.price)).toEqual([50, 50]);
    // fr: 180 words * 0.12 = 21.6, floored to 50. de: 500 words * 0.10 = 50.
  });

  it('prices the same files differently with and without the minimum', () => {
    const files = [90, 90, 90];
    const plain = estimateOrder(
      [{ ...PER_FILE, minWordsPerFile: 0 }],
      'en',
      ['de'],
      files,
    );
    const perFile = estimateOrder([PER_FILE], 'en', ['de'], files);
    expect(plain.total).toBeCloseTo(27);
    expect(perFile.total).toBeCloseTo(75);
  });
});

describe('estimateOrder with a single total', () => {
  it('is unchanged for rates without a per-file minimum', () => {
    expect(estimateOrder(RATES, 'en', ['fr', 'es'], 1000).total).toBeCloseTo(220);
  });

  it('refuses a single total for a pair that needs a count per file', () => {
    // Reading "300 words" as one file would be a wrong number, not an
    // honest "pending": the caller must say what the files were.
    expect(() => estimateOrder([...RATES, PER_FILE], 'en', ['fr', 'de'], 300)).toThrow(
      FileWordCountsRequiredError,
    );
  });
});
