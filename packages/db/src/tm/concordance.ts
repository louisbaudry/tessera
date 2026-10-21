/**
 * Concordance retrieval (`v1-spec.md` §6.1b; issue #170): the source/target
 * pairs in one memory whose text contains a phrase. What the phrase is, and
 * where it sits in a hit, are `core/tm/concordance.ts`'s; this is the query.
 *
 * It reads `tuv_fts` and nothing else for the match, and it is **unranked**:
 * bm25 has to score every hit of a common word before it can return the best
 * 50 (1.4 s at p99 at 1M units, `tm-format-spec.md` §11), where ordering by
 * rowid lets a limit stop the walk. Newest first falls out of that for free,
 * since a later unit has a later id.
 */

import type Database from 'better-sqlite3';

import {
  CONCORDANCE_LIMIT,
  concordanceMatch,
  concordanceWords,
  highlightRanges,
  type ConcordanceSide,
  type TextRange,
  type TmToken,
} from '@cat-tool/core';

import { ensurePrimarySubtagFn, matchingLangs } from '../lang-match.js';
import { qualifySchema } from '../schema-alias.js';
import type { RetrieveOptions } from './retrieve.js';

/**
 * Rows examined per hit wanted, at most. A matched variant whose unit has no
 * variant in the other language is skipped, so a memory of one-sided units
 * could otherwise be walked end to end for a handful of hits.
 */
const EXAMINED_PER_HIT = 20;

export interface ConcordanceParams {
  readonly srcLang: string;
  readonly tgtLang: string;
  /** What was typed or selected; its words become one phrase. */
  readonly text: string;
  /** Which language of the pair is searched. */
  readonly side: ConcordanceSide;
  /** Hits returned, at most. Defaults to {@link CONCORDANCE_LIMIT}. */
  readonly limit?: number;
}

/** One unit that holds the phrase, with both sides of the pair. */
export interface ConcordanceHit {
  readonly tuId: number;
  readonly sourcePlain: string;
  readonly targetPlain: string;
  /** Where the phrase sits in the searched side's text. */
  readonly ranges: readonly TextRange[];
  readonly quality: number;
  readonly updatedAt: string;
  /** The target-language variant of the unit: what an edit names (`edit.ts`). */
  readonly targetTuvId: number;
  /** That variant's `rev` when read; a write names it, and a changed one is refused. */
  readonly targetRev: number;
  /** Whether the target holds text only, the one kind a text edit can replace without losing tags. */
  readonly editable: boolean;
}

export interface ConcordanceResult {
  readonly hits: ConcordanceHit[];
  /** True when more units hold the phrase than `limit` shows. */
  readonly more: boolean;
}

interface MatchRow {
  tuv_id: number;
  tu_id: number;
  plain: string;
  rev: number;
  tokens: string;
  updated_at: string;
}

interface OtherRow {
  tuv_id: number;
  plain: string;
  quality: number;
  rev: number;
  tokens: string;
}

/**
 * The units of one memory that hold the phrase in the searched language, with
 * their other-language text, newest first.
 *
 * Same three-argument shape as `retrievePair` and `retrieveFuzzy`, so an
 * attached memory works (`{ schema }`). Region-insensitive on both languages,
 * through `matchingLangs`, and the FTS index is seeked, never scanned (a test
 * pins the plan). A text with no word is an empty result.
 */
export function retrieveConcordance(
  db: Database.Database,
  params: ConcordanceParams,
  options: RetrieveOptions = {},
): ConcordanceResult {
  const words = concordanceWords(params.text);
  const match = concordanceMatch(words);
  const limit = params.limit ?? CONCORDANCE_LIMIT;
  if (match === null || limit <= 0) return { hits: [], more: false };

  ensurePrimarySubtagFn(db);
  const q = qualifySchema(options.schema);
  const searched = params.side === 'source' ? params.srcLang : params.tgtLang;
  const other = params.side === 'source' ? params.tgtLang : params.srcLang;

  const matches = db
    .prepare<{ match: string; lang: string }, MatchRow>(
      `SELECT m.id AS tuv_id, m.tu_id AS tu_id, m.plain AS plain, m.rev AS rev,
              m.tokens AS tokens, u.updated_at AS updated_at
       FROM   ${q}tuv_fts f
       JOIN   ${q}tuv m ON m.id = f.rowid
       JOIN   ${q}tu  u ON u.id = m.tu_id AND u.deleted = 0
       WHERE  f.plain MATCH @match
         AND  m.lang IN ${matchingLangs(`${q}tuv`, '@lang')}
       ORDER  BY f.rowid DESC`,
    )
    .iterate({ match, lang: searched });

  const otherOf = db.prepare<{ tuId: number; lang: string }, OtherRow>(
    `SELECT t.id AS tuv_id, t.plain AS plain, t.quality AS quality, t.rev AS rev,
            t.tokens AS tokens
     FROM   ${q}tuv t
     WHERE  t.tu_id = @tuId AND primary_subtag(t.lang) = primary_subtag(@lang)
     ORDER  BY t.quality DESC, t.updated_at DESC
     LIMIT  1`,
  );

  const hits: ConcordanceHit[] = [];
  let more = false;
  let examined = 0;
  for (const row of matches) {
    if (++examined > limit * EXAMINED_PER_HIT) break;
    const counterpart = otherOf.get({ tuId: row.tu_id, lang: other });
    if (!counterpart) continue;
    if (hits.length === limit) {
      more = true;
      break;
    }
    const source = params.side === 'source' ? row.plain : counterpart.plain;
    const target = params.side === 'source' ? counterpart.plain : row.plain;
    const targetVariant = params.side === 'source' ? counterpart : row;
    hits.push({
      tuId: row.tu_id,
      sourcePlain: source,
      targetPlain: target,
      ranges: highlightRanges(row.plain, words),
      quality: counterpart.quality,
      updatedAt: row.updated_at,
      targetTuvId: targetVariant.tuv_id,
      targetRev: targetVariant.rev,
      editable: (JSON.parse(targetVariant.tokens) as TmToken[]).every(
        (t) => t.t === 'text',
      ),
    });
  }
  return { hits, more };
}
