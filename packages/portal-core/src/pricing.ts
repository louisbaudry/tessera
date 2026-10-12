/**
 * Pricing (portal-v0-spec.md §3, §4b).
 *
 * Deliberately simple: a per-word rate by language pair, a per-pair
 * minimum price, an optional per-file minimum in words, no
 * discounts/retainers/POs. Pure functions, no DB/HTTP — same headless
 * discipline `@cat-tool/core` follows, provable by a test with nothing
 * else in the loop.
 */

export interface LanguagePairRate {
  readonly srcLang: string;
  readonly tgtLang: string;
  readonly ratePerWord: number;
  readonly minimumPrice: number;
  /**
   * A file counts as at least this many words when priced (spec §4b); `0` or
   * absent is off. A number of words rather than a price, so it follows the
   * rate when the rate changes. Absence-based like the other optional
   * settings: a rate written before the setting existed means what it meant.
   */
  readonly minWordsPerFile?: number;
}

/**
 * Raised when a pair needs a count for each file and only a single total was
 * given. A total cannot say how many files made it, and reading it as one file
 * would quote a wrong number; the caller must supply the counts (spec §4b).
 */
export class FileWordCountsRequiredError extends Error {
  constructor(srcLang: string, tgtLang: string) {
    super(
      `the rate for ${srcLang} -> ${tgtLang} applies a minimum per file: a word count for each file is required`,
    );
    this.name = 'FileWordCountsRequiredError';
  }
}

/** Whether pricing this pair needs a confirmed count for each file (spec §4b). */
export function needsFileWordCounts(rate: LanguagePairRate): boolean {
  return (rate.minWordsPerFile ?? 0) > 0;
}

/**
 * The words one pair is billed for, given each source file's confirmed count.
 * With a per-file minimum, a file of `c` words bills `max(c, minimum)`, except
 * a file of 0 words, which bills nothing: an unchanged file of an update order
 * (§4a) carries no work, and a minimum must not charge for work that does not
 * exist. Without one it is the plain sum.
 *
 * @throws RangeError for a negative or non-finite count.
 */
export function billableWords(
  rate: LanguagePairRate,
  fileWordCounts: readonly number[],
): number {
  const minimum = rate.minWordsPerFile ?? 0;
  let total = 0;
  for (const count of fileWordCounts) {
    if (count < 0 || !Number.isFinite(count)) {
      throw new RangeError(
        `a file's word count must be a non-negative finite number, got ${count}`,
      );
    }
    total += count === 0 ? 0 : Math.max(count, minimum);
  }
  return total;
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
 *
 * `words` is either the order's single confirmed total or one confirmed count
 * per source file. A pair with a per-file minimum (§4b) can only be priced from
 * the per-file counts; given a single total it throws
 * `FileWordCountsRequiredError` rather than guess how many files made it. The
 * minimum price still applies once per target language, after the files are
 * summed.
 */
export function estimateOrder(
  rates: readonly LanguagePairRate[],
  srcLang: string,
  tgtLangs: readonly string[],
  words: number | readonly number[],
): OrderEstimate {
  const lines = tgtLangs.map((tgtLang) => {
    const rate = findRate(rates, srcLang, tgtLang);
    if (typeof words !== 'number') {
      return { tgtLang, rate, price: lineTotal(rate, billableWords(rate, words)) };
    }
    if (needsFileWordCounts(rate)) {
      throw new FileWordCountsRequiredError(srcLang, tgtLang);
    }
    return { tgtLang, rate, price: lineTotal(rate, words) };
  });
  return { total: lines.reduce((sum, l) => sum + l.price, 0), lines };
}
