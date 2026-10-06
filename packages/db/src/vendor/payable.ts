/**
 * A vendor's payable for a job (vendor-spec.md decisions 9–10, its #49
 * note): the words of a project by match tier, priced with the rate card
 * in force on a date. Two files meet here and neither is written: the
 * project (words and origins) and the `.ctv` (rates).
 */

import { existsSync } from 'node:fs';

import {
  FUZZY_FLOOR,
  fuzzyOrigin,
  hasSpacedWords,
  operandOfSource,
  segmentWords,
  type Segment,
  type TmRef,
} from '@cat-tool/core';
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

import { findBestFuzzyMatch } from '../project/pretranslate.js';
import { getProject } from '../project/project.js';
import { listAllSegments, listSegments } from '../project/segments.js';
import { attachTms, detachTms, listTmRefs, tmAlias } from '../project/tm-refs.js';
import { retrievePair } from '../tm/retrieve.js';
import { VendorError } from './error.js';
import { vendorRateAt } from './rates.js';
import { normalizePair, type LanguagePair } from './vendors.js';

/**
 * The words of a project's segments (one file's, or all) by match tier.
 *
 * **A segment with an origin is read from it** (`tierForOrigin`): what
 * pre-translate placed is what it was priced as, and an edit clears it, so
 * this is the analysis made at offer time, not a live figure to re-run over
 * a job in progress. **A segment with none is read from the memories**
 * (`v1-spec.md` §6.1a, 4): an exact hash is `exact`, else its best fuzzy
 * score at the analysis floor is its band. That is what prices a 60% match
 * pre-translate never placed (the threshold is 75), and a project offered
 * before it was pre-translated at all. Only the project's enabled memories
 * whose file exists count: a missing one is skipped, never created by an
 * `ATTACH`. Locked segments and a text box's fallback copy count for
 * nothing, as everywhere (`segmentWords`).
 *
 * A retrieval per distinct segment, so this is bulk work: a server runs it
 * on a worker (`project.analyseTiers`), never on the request thread.
 */
export function analyseTierWords(project: Database.Database, fileId?: number): TierWords {
  const segments: Segment[] =
    fileId === undefined ? listAllSegments(project) : listSegments(project, fileId);
  const memories = attachExistingMemories(project);
  try {
    const lang = getProject(project);
    const consult = lang && memories.refs.length > 0;
    const exactCache = new Map<string, boolean>();
    const fuzzyCache = new Map<string, number | null>();
    const fuzzyOn = consult && hasSpacedWords(lang.srcLang);

    const tierFromMemories = (s: Segment): RateTier => {
      let exact = exactCache.get(s.sourceHash);
      if (exact === undefined) {
        exact = memories.refs.some(
          (ref) =>
            retrievePair(
              project,
              { srcLang: lang!.srcLang, srcHash: s.sourceHash, tgtLang: lang!.tgtLang },
              { schema: tmAlias(ref.id) },
            ).length > 0,
        );
        exactCache.set(s.sourceHash, exact);
      }
      if (exact) return 'exact';
      if (!fuzzyOn) return 'no_match';

      const operand = operandOfSource(s.sourceTokens, s.formatTable);
      const key = `${operand.plain}\u0000${operand.tagSlots.join(',')}`;
      let score = fuzzyCache.get(key);
      if (score === undefined) {
        score =
          findBestFuzzyMatch(
            project,
            memories.refs,
            lang!.srcLang,
            lang!.tgtLang,
            operand,
            FUZZY_FLOOR,
          )?.score ?? null;
        fuzzyCache.set(key, score);
      }
      return score === null ? 'no_match' : tierForOrigin(fuzzyOrigin(score));
    };

    const words: Partial<Record<RateTier, number>> = {};
    for (const s of segments) {
      const n = segmentWords(s);
      if (n === 0) continue;
      const tier =
        s.origin === null
          ? consult
            ? tierFromMemories(s)
            : 'no_match'
          : tierForOrigin(s.origin);
      words[tier] = (words[tier] ?? 0) + n;
    }
    return words;
  } finally {
    memories.release();
  }
}

/**
 * Attaches the project's enabled memories whose file exists, and hands back a
 * way to detach exactly those it attached (a connection that already had
 * some attached keeps them). A path that does not exist is left out: SQLite
 * would create an empty database there.
 */
function attachExistingMemories(project: Database.Database): {
  refs: TmRef[];
  release: () => void;
} {
  const before = new Set(
    (project.pragma('database_list') as Array<{ name: string }>).map((d) => d.name),
  );
  const refs = attachTms(
    project,
    listTmRefs(project).filter((r) => existsSync(r.path)),
  );
  return {
    refs,
    release: () =>
      detachTms(
        project,
        refs.filter((r) => !before.has(tmAlias(r.id))),
      ),
  };
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
