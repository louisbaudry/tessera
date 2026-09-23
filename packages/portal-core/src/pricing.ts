/**
 * Pricing (portal-v0-spec.md §3).
 *
 * Deliberately simple: a per-word rate by language pair, a per-pair
 * minimum price, no discounts/retainers/POs. Pure functions, no DB/HTTP —
 * same headless discipline `@cat-tool/core` follows, provable by a test
 * with nothing else in the loop.
 */

export interface LanguagePairRate {
  readonly srcLang: string;
  readonly tgtLang: string;
  readonly ratePerWord: number;
  readonly minimumPrice: number;
}

export class RateNotFoundError extends Error {
  constructor(srcLang: string, tgtLang: string) {
    super(`no rate configured for ${srcLang} -> ${tgtLang}`);
    this.name = 'RateNotFoundError';
  }
}

export function findRate(
  rates: readonly LanguagePairRate[],
  srcLang: string,
  tgtLang: string,
): LanguagePairRate {
  const rate = rates.find((r) => r.srcLang === srcLang && r.tgtLang === tgtLang);
  if (!rate) {
    throw new RateNotFoundError(srcLang, tgtLang);
  }
  return rate;
}

/** One target language's price: `max(wordCount * ratePerWord, minimumPrice)`. */
export function lineTotal(rate: LanguagePairRate, wordCount: number): number {
  if (wordCount < 0 || !Number.isFinite(wordCount)) {
    throw new RangeError(
      `wordCount must be a non-negative finite number, got ${wordCount}`,
    );
  }
  return Math.max(wordCount * rate.ratePerWord, rate.minimumPrice);
}

export interface OrderEstimate {
  readonly total: number;
  readonly lines: ReadonlyArray<{
    readonly tgtLang: string;
    readonly rate: LanguagePairRate;
    readonly price: number;
  }>;
}

/**
 * Prices an order across every requested target language. Throws
 * `RateNotFoundError` (not a silent zero) if any pair has no configured
 * rate — a missing rate is a configuration gap the admin must fix, not a
 * free translation.
 */
export function estimateOrder(
  rates: readonly LanguagePairRate[],
  srcLang: string,
  tgtLangs: readonly string[],
  wordCount: number,
): OrderEstimate {
  const lines = tgtLangs.map((tgtLang) => {
    const rate = findRate(rates, srcLang, tgtLang);
    return { tgtLang, rate, price: lineTotal(rate, wordCount) };
  });
  return { total: lines.reduce((sum, l) => sum + l.price, 0), lines };
}
