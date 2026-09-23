/**
 * Pair retrieval — the `tuv`-to-`tuv` self-join (tm-format-spec.md §2.3;
 * backlog #15e).
 *
 * A unit is language-neutral; retrieval for any `(src, tgt)` pair, in
 * either direction, is the same join with the roles swapped. There is no
 * separate "reverse lookup" code path because the schema never encoded a
 * direction to begin with.
 */

import type Database from 'better-sqlite3';

import { primarySubtag } from '@cat-tool/core';
import type { TmToken } from '@cat-tool/core';

import { qualifySchema } from '../schema-alias.js';

export interface RetrievePairParams {
  readonly srcLang: string;
  readonly srcHash: string;
  readonly tgtLang: string;
}

export interface RetrieveOptions {
  /**
   * Schema alias to qualify `tuv`/`tu` with, for querying an ATTACHed
   * TM from a project connection (`tmAlias(ref.id)`,
   * `db/project/tm-refs.ts` — backlog #19's exact matcher is the first
   * caller). Omitted for the common case: calling this on a `.ctm`
   * file's own connection, where `tuv`/`tu` are unqualified. Same shape
   * as `glossary/terms.ts`'s `ReadOptions` — one option, two readers.
   */
  readonly schema?: string;
}

export interface PairMatch {
  readonly tuId: number;
  readonly tuvId: number;
  /** The matched variant's actual stored language — may differ in region
   *  from `tgtLang` when the region-insensitive fallback applied. */
  readonly lang: string;
  readonly tokens: readonly TmToken[];
  readonly quality: number;
  readonly updatedAt: string;
}

const registeredPrimarySubtagFn = new WeakSet<Database.Database>();

/**
 * `primary_subtag(lang)` as a SQL scalar function, so the region-
 * insensitive match condition can live in the query instead of pulling
 * every candidate row into JS to filter. Registered once per connection
 * — `better-sqlite3` throws if the same function name is registered
 * twice on one `Database`. Exported so the glossary repository shares
 * this one guard rather than registering the same name a second time.
 */
export function ensurePrimarySubtagFn(db: Database.Database): void {
  if (registeredPrimarySubtagFn.has(db)) return;
  db.function('primary_subtag', { deterministic: true }, (lang: unknown) =>
    primarySubtag(String(lang)),
  );
  registeredPrimarySubtagFn.add(db);
}

interface Row {
  tu_id: number;
  tuv_id: number;
  lang: string;
  tokens: string;
  quality: number;
  updated_at: string;
}

/**
 * Retrieves every non-tombstoned target variant matching a source hash,
 * for any language pair — best quality and most recent first.
 *
 * The language match is **region-insensitive**: a query for `es-ES`
 * matches a variant stored as bare `es` (or `es-419`), and vice versa
 * (tm-format-spec.md §12.2 — "fine for one translator", the case this is
 * built for). Both `srcLang` and `tgtLang` get the same treatment, so a
 * document tagged `en-GB` still finds a memory built with bare `en`.
 */
export function retrievePair(
  db: Database.Database,
  params: RetrievePairParams,
  options: RetrieveOptions = {},
): PairMatch[] {
  ensurePrimarySubtagFn(db);
  const q = qualifySchema(options.schema);
  const rows = db
    .prepare<RetrievePairParams, Row>(
      `SELECT t.id AS tuv_id, t.tu_id AS tu_id, t.lang AS lang,
              t.tokens AS tokens, t.quality AS quality, t.updated_at AS updated_at
       FROM   ${q}tuv s
       JOIN   ${q}tuv t ON t.tu_id = s.tu_id
                    AND primary_subtag(t.lang) = primary_subtag(@tgtLang)
       JOIN   ${q}tu  u ON u.id = s.tu_id AND u.deleted = 0
       WHERE  primary_subtag(s.lang) = primary_subtag(@srcLang)
         AND  s.hash = @srcHash
       ORDER  BY t.quality DESC, t.updated_at DESC`,
    )
    .all(params);

  return rows.map((row) => ({
    tuId: row.tu_id,
    tuvId: row.tuv_id,
    lang: row.lang,
    tokens: JSON.parse(row.tokens) as TmToken[],
    quality: row.quality,
    updatedAt: row.updated_at,
  }));
}
