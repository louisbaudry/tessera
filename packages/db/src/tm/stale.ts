/**
 * The stale-work scan over a memory (`smart-glossary-spec.md` §6.2; backlog #116):
 * which stored units use a rendering the glossary now prefers against or forbids.
 * It reads and reports; nothing is written, and the memory is opened by the
 * caller. The matcher and the rule of what counts as stale are `core`'s
 * (`mismatchFinder`, `isStaleUse`); this is the walk over the units.
 *
 * The walk is a keyset page by unit id, so a stop is seen between pages and a
 * progress fraction is the id reached over the highest id. Each page seeks the
 * unit table by its primary key and each variant by `(tu_id, lang)`, with the
 * languages matched by primary subtag (`matchingLangs`, backlog #19a): no scan
 * of the variant table at any size (asserted in `stale.test.ts`).
 *
 * `CROSS JOIN` is the point of the query, not style: without it SQLite drove the
 * walk from the variants of the source language (all of them, every page) and
 * sorted the lot, which is quadratic over a memory. It fixes the join order, so
 * the units are read in id order from `after` and the `LIMIT` stops the read.
 */

import {
  asTextTokens,
  isStaleUse,
  mismatchFinder,
  type GlossaryTermEntry,
  type MismatchKind,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { ensurePrimarySubtagFn, matchingLangs } from '../lang-match.js';

/** One stored unit that uses an old rendering of one term. */
export interface StaleRow {
  readonly tuUuid: string;
  /** The unit's own source and target text, as stored. */
  readonly source: string;
  readonly target: string;
  readonly termId: number;
  /** The source form of the term that matched. */
  readonly term: string;
  readonly kind: MismatchKind;
  /** What the glossary prefers now; null when only forbidden forms exist. */
  readonly preferred: string | null;
  /** The old or forbidden rendering the target uses. */
  readonly found: string | null;
}

export interface StaleScan {
  /** The glossary's terms for the pair; with none, nothing is read. */
  readonly entries: number;
  /** Units read (a unit holding the pair, not deleted). */
  readonly scanned: number;
  /** Every unit-and-term pair found, counted past the cap. */
  readonly total: number;
  /** The first `limit` of them, in unit order. */
  readonly rows: readonly StaleRow[];
  readonly truncated: boolean;
  /** False when it was stopped: the rest of the memory was not read. */
  readonly complete: boolean;
}

export interface ScanOptions {
  /** Rows returned at most; the count is not capped. */
  readonly limit?: number;
  readonly batchSize?: number;
  readonly onProgress?: (p: { scanned: number; fraction: number | null }) => void;
  /** Asked between pages: true ends the scan with what it has. */
  readonly shouldStop?: () => boolean;
}

export const DEFAULT_STALE_LIMIT = 500;
const DEFAULT_BATCH = 2000;

interface Page {
  id: number;
  uuid: string;
  src: string;
  tgt: string;
}

/**
 * Scans the memory's units for the pair `langs` against `entries` (from
 * `listTermEntries` over the glossary), reporting those that use a forbidden
 * rendering or a non-preferred acceptable one.
 */
export function scanTmForStale(
  tm: Database.Database,
  entries: readonly GlossaryTermEntry[],
  langs: { readonly srcLang: string; readonly tgtLang: string },
  options: ScanOptions = {},
): StaleScan {
  const limit = options.limit ?? DEFAULT_STALE_LIMIT;
  const batch = options.batchSize ?? DEFAULT_BATCH;
  if (entries.length === 0) {
    return {
      entries: 0,
      scanned: 0,
      total: 0,
      rows: [],
      truncated: false,
      complete: true,
    };
  }
  ensurePrimarySubtagFn(tm);
  const find = mismatchFinder(entries, langs);
  const last = (tm.prepare('SELECT MAX(id) AS id FROM tu').get() as { id: number | null })
    .id;
  const page = tm.prepare(
    `SELECT tu.id AS id, tu.uuid AS uuid, s.plain AS src, t.plain AS tgt
       FROM tu
       CROSS JOIN tuv s ON s.tu_id = tu.id AND s.lang IN ${matchingLangs('tuv', '@srcLang')}
       CROSS JOIN tuv t ON t.tu_id = tu.id AND t.id <> s.id
                 AND t.lang IN ${matchingLangs('tuv', '@tgtLang')}
      WHERE tu.deleted = 0 AND tu.id > @after
      ORDER BY tu.id
      LIMIT @batch`,
  );

  const rows: StaleRow[] = [];
  let total = 0;
  let scanned = 0;
  let after = 0;
  let complete = true;
  for (;;) {
    if (options.shouldStop?.()) {
      complete = false;
      break;
    }
    const units = page.all({
      srcLang: langs.srcLang,
      tgtLang: langs.tgtLang,
      after,
      batch,
    }) as Page[];
    if (units.length === 0) break;
    for (const unit of units) {
      scanned++;
      for (const m of find(asTextTokens(unit.src), asTextTokens(unit.tgt))) {
        if (!isStaleUse(m)) continue;
        total++;
        if (rows.length < limit) {
          rows.push({
            tuUuid: unit.uuid,
            source: unit.src,
            target: unit.tgt,
            termId: m.termId,
            term: m.term,
            kind: m.kind,
            preferred: m.preferred,
            found: m.found,
          });
        }
      }
    }
    after = units[units.length - 1]!.id;
    options.onProgress?.({
      scanned,
      fraction: last !== null && last > 0 ? Math.min(1, after / last) : null,
    });
  }
  return {
    entries: entries.length,
    scanned,
    total,
    rows,
    truncated: total > rows.length,
    complete,
  };
}
