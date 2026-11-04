/**
 * A quote for a priced order (issue #179, `planning/solo-translator-spec.md` D3).
 *
 * A quote is a view of the price the client is asked to approve, never a second price: its total
 * is always the order's stored price. The breakdown per target language is recomputed from the
 * client's rates (`estimateOrder`) and shown only when its lines add up to that price; when they
 * don't (the admin set another price, or a rate moved since pricing), the quote is one line for
 * the whole order. Pure, as the rest of `portal-core`.
 */

import {
  billableWords,
  estimateOrder,
  type LanguagePairRate,
  type OrderEstimate,
} from './pricing.js';

/** One target language's part of a quote. */
export interface QuoteLine {
  readonly tgtLang: string;
  /** The words this language is billed for (after any per-file minimum, spec §4b). */
  readonly billedWords: number;
  readonly ratePerWord: number;
  /** Set when the pair's minimum price, not the words, made this line's price. */
  readonly minimumApplied: boolean;
  readonly price: number;
}

export interface Quote {
  readonly srcLang: string;
  readonly tgtLangs: readonly string[];
  /** The order's confirmed word count: the actual words, not the billed ones. */
  readonly wordCount: number;
  /** Always the order's stored price. */
  readonly total: number;
  /** The breakdown, or `null` when it does not add up to `total` and the quote is one line. */
  readonly lines: readonly QuoteLine[] | null;
}

/** What a quote is made from: the order as stored, and the client's rates (spec §3a). */
export interface QuoteInput {
  readonly srcLang: string;
  readonly tgtLangs: readonly string[];
  readonly wordCount: number;
  readonly price: number;
  /** Each source file's confirmed count, when the order was priced per file (§4b); else empty. */
  readonly fileWordCounts: readonly number[];
  readonly rates: readonly LanguagePairRate[];
}

/** Prices are compared to the cent: a breakdown off by rounding noise still adds up. */
const sameAmount = (a: number, b: number) => Math.abs(a - b) < 0.005;

/**
 * The quote for an order that has a price.
 *
 * @param input - The order's languages, confirmed words and price, with the client's rates.
 * @returns The quote; `lines` is `null` when the rates no longer explain the price.
 */
export function quoteFor(input: QuoteInput): Quote {
  const base = {
    srcLang: input.srcLang,
    tgtLangs: input.tgtLangs,
    wordCount: input.wordCount,
    total: input.price,
  };
  let estimate: OrderEstimate;
  try {
    estimate = estimateOrder(
      input.rates,
      input.srcLang,
      input.tgtLangs,
      input.fileWordCounts.length > 0 ? input.fileWordCounts : input.wordCount,
    );
  } catch {
    // A rate removed since pricing, or a per-file minimum with no per-file counts: the price
    // stands and the breakdown cannot be shown.
    return { ...base, lines: null };
  }
  if (!sameAmount(estimate.total, input.price)) return { ...base, lines: null };
  return {
    ...base,
    lines: estimate.lines.map((line) => {
      const billedWords =
        input.fileWordCounts.length > 0
          ? billableWords(line.rate, input.fileWordCounts)
          : input.wordCount;
      return {
        tgtLang: line.tgtLang,
        billedWords,
        ratePerWord: line.rate.ratePerWord,
        minimumApplied: line.rate.minimumPrice > billedWords * line.rate.ratePerWord,
        price: line.price,
      };
    }),
  };
}
