import { describe, expect, it } from 'vitest';

import type { LanguagePairRate } from './pricing.js';
import { quoteFor } from './quote.js';

const de: LanguagePairRate = {
  srcLang: 'en',
  tgtLang: 'de',
  ratePerWord: 0.1,
  minimumPrice: 30,
};
const fr: LanguagePairRate = {
  srcLang: 'en',
  tgtLang: 'fr',
  ratePerWord: 0.12,
  minimumPrice: 30,
};

describe('quoteFor (issue #179, solo-translator-spec D3)', () => {
  it('breaks the stored price down per target language when the rates add up to it', () => {
    const quote = quoteFor({
      srcLang: 'en',
      tgtLangs: ['de', 'fr'],
      wordCount: 1000,
      price: 220,
      fileWordCounts: [],
      rates: [de, fr],
    });
    expect(quote.total).toBe(220);
    expect(quote.lines).toEqual([
      {
        tgtLang: 'de',
        billedWords: 1000,
        ratePerWord: 0.1,
        minimumApplied: false,
        price: 100,
      },
      {
        tgtLang: 'fr',
        billedWords: 1000,
        ratePerWord: 0.12,
        minimumApplied: false,
        price: 120,
      },
    ]);
  });

  it('marks a line the minimum price made', () => {
    const quote = quoteFor({
      srcLang: 'en',
      tgtLangs: ['de'],
      wordCount: 100,
      price: 30,
      fileWordCounts: [],
      rates: [de],
    });
    expect(quote.lines?.[0]).toMatchObject({ minimumApplied: true, price: 30 });
  });

  it('never shows a total other than the stored price: a price the rates do not explain is one line', () => {
    const quote = quoteFor({
      srcLang: 'en',
      tgtLangs: ['de'],
      wordCount: 1000,
      price: 95,
      fileWordCounts: [],
      rates: [de],
    });
    expect(quote.total).toBe(95);
    expect(quote.lines).toBeNull();
  });

  it('is one line when a rate is gone since pricing', () => {
    const quote = quoteFor({
      srcLang: 'en',
      tgtLangs: ['de', 'ja'],
      wordCount: 1000,
      price: 250,
      fileWordCounts: [],
      rates: [de],
    });
    expect(quote).toMatchObject({ total: 250, lines: null });
  });

  it('bills a per-file minimum from the confirmed counts, and shows the billed words', () => {
    const perFile = { ...de, minWordsPerFile: 250, minimumPrice: 0 };
    const quote = quoteFor({
      srcLang: 'en',
      tgtLangs: ['de'],
      wordCount: 1100,
      price: 125,
      fileWordCounts: [100, 1000, 0],
      rates: [perFile],
    });
    expect(quote.wordCount).toBe(1100);
    expect(quote.lines?.[0]).toMatchObject({ billedWords: 1250, price: 125 });
  });
});
