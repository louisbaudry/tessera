/**
 * What a vendor is owed for a job (`planning/vendor-spec.md` §1 decisions 9
 * and 10, and its #49 note). Pure: words per match tier and a rate per tier
 * in, an integer amount out. Where the words come from, and which rate is in
 * force, is `db`'s; this is the arithmetic and the two rules that keep it
 * honest.
 */

import { RATE_TIERS, type RateTier } from './profile.js';

/** Whole words per tier. A tier absent is zero words. */
export type TierWords = Partial<Record<RateTier, number>>;

/** Micros of a currency unit per word, per tier. A tier absent has no rate. */
export type TierRates = Partial<Record<RateTier, number>>;

/**
 * The tier a segment was *analysed* as, from the origin it was pre-translated
 * with. **Read it when the analysis is made, never later**: a translator's
 * edit clears `origin` (`editSegmentTarget`), so the same function over a
 * live segment would pay an edited 100% match as no match at all.
 *
 * `tm_exact`, its tag-different draft and a propagated repetition are
 * `exact` (decision 9: "100% and repetitions"); `tm_ice` is `ice`;
 * `tm_fuzzy_NN` lands in the band holding NN, and below 50 is no match.
 * Anything else, `null` included, is `no_match`.
 */
export function tierForOrigin(origin: string | null): RateTier {
  if (origin === 'tm_exact' || origin === 'tm_exact_tagdiff' || origin === 'propagated') {
    return 'exact';
  }
  if (origin === 'tm_ice') return 'ice';
  const fuzzy = /^tm_fuzzy_(\d{1,3})$/.exec(origin ?? '');
  if (fuzzy) {
    const pct = Number(fuzzy[1]);
    if (pct >= 95 && pct <= 99) return 'fuzzy_95_99';
    if (pct >= 85 && pct < 95) return 'fuzzy_85_94';
    if (pct >= 75 && pct < 85) return 'fuzzy_75_84';
    if (pct >= 50 && pct < 75) return 'fuzzy_50_74';
  }
  return 'no_match';
}

export interface PayableLine {
  readonly tier: RateTier;
  readonly words: number;
  /** Null when the card has no rate for this tier. */
  readonly rateMicros: number | null;
  /** `words × rateMicros`; 0 when there is no rate (see {@link Payable.unpriced}). */
  readonly amountMicros: number;
}

export interface Payable {
  /** Only the priced tiers: an unpriced tier adds nothing here and is named below. */
  readonly totalMicros: number;
  readonly words: number;
  /** One line per tier with words, in `RATE_TIERS` order. */
  readonly lines: readonly PayableLine[];
  /**
   * Tiers that have words but no rate. **A missing rate is never zero**:
   * a total that quietly priced them at nothing would be shown to a vendor
   * as what they are owed. A caller with anything here has a partial total
   * and must say so.
   */
  readonly unpriced: readonly RateTier[];
}

export function computePayable(words: TierWords, rates: TierRates): Payable {
  const lines: PayableLine[] = [];
  const unpriced: RateTier[] = [];
  let totalMicros = 0;
  let totalWords = 0;
  for (const tier of RATE_TIERS) {
    const w = words[tier] ?? 0;
    if (!Number.isSafeInteger(w) || w < 0) {
      throw new RangeError(`words for ${tier} must be a non-negative integer, got ${w}`);
    }
    if (w === 0) continue;
    const rate = rates[tier];
    if (rate !== undefined && (!Number.isSafeInteger(rate) || rate < 0)) {
      throw new RangeError(`rate for ${tier} must be a non-negative integer of micros`);
    }
    const amount = rate === undefined ? 0 : w * rate;
    if (rate === undefined) unpriced.push(tier);
    totalWords += w;
    totalMicros += amount;
    lines.push({ tier, words: w, rateMicros: rate ?? null, amountMicros: amount });
  }
  if (!Number.isSafeInteger(totalMicros)) {
    throw new RangeError('a payable that large is not an integer of micros');
  }
  return { totalMicros, words: totalWords, lines, unpriced };
}
