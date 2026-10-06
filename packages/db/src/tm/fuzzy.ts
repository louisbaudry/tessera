/**
 * Fuzzy retrieval (`v1-spec.md` §6.1a; backlog #61).
 *
 * Two stages, kept apart so the first can change without touching the
 * second (§6.1a, 6): a **shortlist** that SQLite can answer from an index —
 * the FTS5 projection of `tuv.plain` — and the **scorer**
 * (`core/tm/fuzzy.ts`, FS-2) over that shortlist. Only the shortlist
 * touches the database's size; the scorer runs a fixed number of times.
 *
 * The shortlist is the part `tm-format-spec.md` §12.5 leaves open: a
 * top-50 FTS shortlist lost the best edit-distance match one time in three
 * at 1M units. What lives here is the interim default, and §11 records what
 * it measured.
 */

import type Database from 'better-sqlite3';

import {
  FUZZY_FLOOR,
  operandOfTm,
  scoreFuzzy,
  type FuzzyOperand,
  type TmToken,
} from '@cat-tool/core';

import { ensurePrimarySubtagFn, matchingLangs } from '../lang-match.js';
import { qualifySchema } from '../schema-alias.js';
import type { RetrieveOptions } from './retrieve.js';

/** Candidates the FTS stage hands to the scorer, best bm25 first. */
export const DEFAULT_SHORTLIST = 200;

/** Query terms used per segment, at most. */
const MAX_QUERY_TERMS = 12;

/**
 * Postings the FTS stage may read for one segment: the sum, over the terms
 * it queries, of the units each occurs in. bm25 has to rank every unit that
 * holds any of them, so this is the stage's cost, and it is what a segment
 * made of common words would otherwise blow through (a top-12-longest-words
 * query took 187 ms at 200,000 units and `tm-format-spec.md` §11 has the
 * rest). A fixed number, not a share of the memory: a pre-translate over a
 * large memory must cost the same per segment as over a small one, and the
 * recall it gives up as the memory grows is what §11 measures.
 */
export const POSTING_BUDGET = 20_000;

export interface RetrieveFuzzyParams {
  readonly srcLang: string;
  readonly tgtLang: string;
  /** The segment being matched, as the scorer reads it (`operandOfSource`). */
  readonly source: FuzzyOperand;
  /** The lowest score returned; defaults to the analysis floor. */
  readonly minScore?: number;
  /** Matches returned, best first. Defaults to 3. */
  readonly limit?: number;
  /** Candidates scored. Defaults to {@link DEFAULT_SHORTLIST}. */
  readonly shortlist?: number;
}

export interface FuzzyMatch {
  readonly score: number;
  readonly tuId: number;
  readonly tuvId: number;
  /** The matched unit's source text, for showing what differed. */
  readonly sourcePlain: string;
  /** The target variant's stored language (may differ in region from `tgtLang`). */
  readonly lang: string;
  readonly tokens: readonly TmToken[];
  readonly quality: number;
  readonly updatedAt: string;
}

interface CandidateRow {
  tuv_id: number;
  tu_id: number;
  tokens: string;
  plain: string;
}

interface TargetRow {
  tuv_id: number;
  lang: string;
  tokens: string;
  quality: number;
  updated_at: string;
}

/**
 * The FTS5 `MATCH` expression for a segment's text: its rarest distinct
 * words that fit the posting budget, each quoted so punctuation in a word
 * can never be read as query syntax, joined with `OR`. At least two terms
 * are always used (a segment of common words still has to be asked about),
 * at most {@link MAX_QUERY_TERMS}. `null` for a text with no words.
 *
 * `docs` is how many units hold a word. Without it (a connection that
 * cannot read the vocabulary) the longest words stand in for the rarest,
 * which is slower on a large memory and never wrong.
 */
export function ftsQuery(plain: string, docs?: (word: string) => number): string | null {
  const words = new Set<string>();
  for (const m of plain.matchAll(/[\p{L}\p{M}\p{N}]+/gu)) words.add(m[0].toLowerCase());
  if (words.size === 0) return null;
  const rank = new Map<string, number>(
    [...words].map((w) => [w, docs ? docs(w) : -w.length]),
  );
  const ordered = [...words].sort(
    (a, b) => rank.get(a)! - rank.get(b)! || (a < b ? -1 : a > b ? 1 : 0),
  );
  const chosen: string[] = [];
  let postings = 0;
  for (const w of ordered) {
    if (chosen.length >= MAX_QUERY_TERMS) break;
    const n = docs ? rank.get(w)! : 0;
    if (chosen.length >= 2 && postings + n > POSTING_BUDGET) break;
    chosen.push(w);
    postings += n;
  }
  return chosen.map((w) => `"${w}"`).join(' OR ');
}

const vocabularies = new WeakMap<Database.Database, Map<string, string | null>>();

/**
 * A per-connection `fts5vocab` table over `tuv_fts` in `schema` (a temp
 * table: nothing is written to the memory), or `null` when the connection
 * cannot make one (`peekTm`'s `query_only` handle cannot). It answers "in
 * how many units does this word occur" with an index seek, which is what
 * the posting budget needs and a `COUNT` over the postings would cost as
 * much as the query itself.
 */
function vocabulary(db: Database.Database, schema: string | undefined): string | null {
  const key = schema ?? 'main';
  let known = vocabularies.get(db);
  if (!known) vocabularies.set(db, (known = new Map()));
  if (known.has(key)) return known.get(key)!;
  const name = `fuzzy_vocab_${key}`;
  let made: string | null = null;
  try {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS temp.${name} USING fts5vocab(${key}, tuv_fts, 'row')`,
    );
    made = name;
  } catch {
    made = null;
  }
  known.set(key, made);
  return made;
}

/** How many units hold a word, or `undefined` when this connection cannot say. */
function documentCounter(
  db: Database.Database,
  schema: string | undefined,
): ((word: string) => number) | undefined {
  const name = vocabulary(db, schema);
  if (name === null) return undefined;
  let stmt: Database.Statement<[string], { doc: number }>;
  try {
    stmt = db.prepare<[string], { doc: number }>(
      `SELECT doc FROM temp.${name} WHERE term = ?`,
    );
  } catch {
    // The schema it read was detached since: forget it, and make the next call a new one.
    vocabularies.get(db)?.delete(schema ?? 'main');
    return undefined;
  }
  // The index folds case and strips diacritics (`unicode61 remove_diacritics`),
  // so a lookup must too or it finds nothing and calls a common word rare.
  return (word) => stmt.get(word.normalize('NFD').replace(/\p{M}/gu, ''))?.doc ?? 0;
}

/**
 * The best fuzzy matches for a segment in one memory, by FS-2 score and
 * then quality and recency. Each result is one source unit with its
 * best target variant for `tgtLang`; a unit with none is skipped.
 *
 * Same three-argument shape as `retrievePair`, so an attached memory
 * works (`{ schema }`). The language match is region-insensitive in the
 * same way, through `matchingLangs`, and the shortlist query seeks the
 * FTS index rather than scanning `tuv` (a test pins the plan).
 *
 * A match with a score of 100 cannot occur: the scorer caps at 99, since
 * an exact match is the hash path (`retrievePair`), run first.
 */
export function retrieveFuzzy(
  db: Database.Database,
  params: RetrieveFuzzyParams,
  options: RetrieveOptions = {},
): FuzzyMatch[] {
  ensurePrimarySubtagFn(db);
  const q = qualifySchema(options.schema);
  const query = ftsQuery(params.source.plain, documentCounter(db, options.schema));
  if (query === null) return [];
  const minScore = params.minScore ?? FUZZY_FLOOR;
  const limit = params.limit ?? 3;

  const candidates = db
    .prepare<{ query: string; srcLang: string; shortlist: number }, CandidateRow>(
      `SELECT s.id AS tuv_id, s.tu_id AS tu_id, s.tokens AS tokens, s.plain AS plain
       FROM   ${q}tuv_fts f
       JOIN   ${q}tuv s ON s.id = f.rowid
       JOIN   ${q}tu  u ON u.id = s.tu_id AND u.deleted = 0
       WHERE  f.plain MATCH @query
         AND  s.lang IN ${matchingLangs(`${q}tuv`, '@srcLang')}
       ORDER  BY f.rank
       LIMIT  @shortlist`,
    )
    .all({
      query,
      srcLang: params.srcLang,
      shortlist: params.shortlist ?? DEFAULT_SHORTLIST,
    });

  const scored: Array<{ row: CandidateRow; score: number }> = [];
  for (const row of candidates) {
    const operand = operandOfTm(JSON.parse(row.tokens) as TmToken[], row.plain);
    const score = scoreFuzzy(params.source, operand, minScore);
    if (score !== null) scored.push({ row, score });
  }
  scored.sort((a, b) => b.score - a.score);

  const targetOf = db.prepare<{ tuId: number; tgtLang: string }, TargetRow>(
    `SELECT t.id AS tuv_id, t.lang AS lang, t.tokens AS tokens,
            t.quality AS quality, t.updated_at AS updated_at
     FROM   ${q}tuv t
     WHERE  t.tu_id = @tuId AND primary_subtag(t.lang) = primary_subtag(@tgtLang)
     ORDER  BY t.quality DESC, t.updated_at DESC
     LIMIT  1`,
  );

  const out: FuzzyMatch[] = [];
  for (const { row, score } of scored) {
    const target = targetOf.get({ tuId: row.tu_id, tgtLang: params.tgtLang });
    if (!target) continue;
    out.push({
      score,
      tuId: row.tu_id,
      tuvId: target.tuv_id,
      sourcePlain: row.plain,
      lang: target.lang,
      tokens: JSON.parse(target.tokens) as TmToken[],
      quality: target.quality,
      updatedAt: target.updated_at,
    });
  }
  // Score first; ties on quality, then recency, as `retrievePair` orders.
  out.sort(
    (a, b) =>
      b.score - a.score ||
      b.quality - a.quality ||
      (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0),
  );
  return out.slice(0, limit);
}
