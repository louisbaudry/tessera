/**
 * A vendor's payable for a job (vendor-spec.md decisions 9–10, its #49
 * note): the words of a project by match tier, priced with the rate card
 * in force on a date. Two files meet here and neither is written: the
 * project (words and origins) and the `.ctv` (rates).
 */

import { hasSpacedWords, segmentWords, type Segment } from '@cat-tool/core';
import {
  computePayable,
  isRateTier,
  RATE_TIERS,
  tierForOrigin,
  type Payable,
  type RateTier,
  type TierRates,
  type TierWords,
} from '@cat-tool/vendor-core';
import type Database from 'better-sqlite3';

import { listAllSegments, listSegments } from '../project/segments.js';
import { VendorError } from './error.js';
import { vendorRateAt } from './rates.js';
import { normalizePair, type LanguagePair } from './vendors.js';

/**
 * The words of a project's segments (one file's, or all) by the tier of the
 * origin each was pre-translated with. **Only true while that origin is
 * there**: an edit clears it, so this is the analysis made at offer time,
 * not a live figure to re-run over a job in progress (see
 * `tierForOrigin`). Locked segments and a text box's fallback copy count
 * for nothing, as everywhere (`segmentWords`).
 */
export function analyseTierWords(project: Database.Database, fileId?: number): TierWords {
  const segments: Segment[] =
    fileId === undefined ? listAllSegments(project) : listSegments(project, fileId);
  const words: Partial<Record<RateTier, number>> = {};
  for (const s of segments) {
    const n = segmentWords(s);
    if (n === 0) continue;
    const tier = tierForOrigin(s.origin);
    words[tier] = (words[tier] ?? 0) + n;
  }
  return words;
}

export interface PayableOptions {
  readonly vendorId: number;
  readonly pair: LanguagePair;
  readonly words: TierWords;
  /** The date whose rate card applies: an assignment's offer date. */
  readonly at: string | Date;
}

export interface VendorPayable extends Payable {
  /** ISO 4217, or null when no tier with words has a rate. */
  readonly currency: string | null;
}

/**
 * Prices `words` with each tier's rate in force at `at`. Refuses a card
 * that prices the tiers in more than one currency: adding them would be a
 * number in no currency. A tier with no rate in force is `unpriced`, never
 * zero (`computePayable`).
 */
export function priceTierWords(
  db: Database.Database,
  options: PayableOptions,
): VendorPayable {
  const pair = normalizePair(options.pair);
  if (!hasSpacedWords(pair.src)) {
    // A word is not a unit of work in a language that does not space its
    // words (`countRegionWords` is null for them): refuse, don't invent one.
    throw new VendorError(
      `${pair.src} has no word count, so a per-word payable is not defined for it`,
    );
  }
  if (!db.prepare('SELECT 1 FROM vendor WHERE id = ?').get(options.vendorId)) {
    throw new VendorError(`no vendor #${options.vendorId}`);
  }
  const rates: Partial<Record<RateTier, number>> = {};
  const currencies = new Set<string>();
  for (const tier of RATE_TIERS) {
    if (!(options.words[tier] && isRateTier(tier))) continue;
    const entry = vendorRateAt(
      db,
      { vendorId: options.vendorId, pair, tier },
      options.at,
    );
    if (!entry) continue;
    rates[tier] = entry.rateMicros;
    currencies.add(entry.currency);
  }
  if (currencies.size > 1) {
    throw new VendorError(
      `the rate card prices ${pair.src}→${pair.tgt} in more than one currency ` +
        `(${[...currencies].sort().join(', ')}): a payable cannot be summed`,
    );
  }
  const payable = computePayable(options.words, rates as TierRates);
  return { ...payable, currency: [...currencies][0] ?? null };
}
