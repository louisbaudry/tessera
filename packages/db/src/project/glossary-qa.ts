/**
 * The glossary side of `term.glossary_mismatch` (smart-glossary-spec.md §6;
 * backlog #44): the project's write-target `.ctg`, read into a matcher the
 * QA pass applies to each segment.
 *
 * Only the write target is consulted, for the reason §5a.1 gives for the
 * panel's list: a glossary session, a mismatch row and a recorded exception
 * all name a term of one file, and the rule must agree with the panel about
 * which segments are flagged.
 */

import { existsSync } from 'node:fs';

import { mismatchFinder, type MismatchFinder } from '@cat-tool/core';
import Database from 'better-sqlite3';

import { listTermEntries } from '../glossary/terms.js';
import { listGlossaryRefs } from './glossary-refs.js';

/** A glossary's matcher, kept while the glossary's rows are what they were. */
const cache = new Map<string, { fingerprint: string; finder: MismatchFinder }>();
const CACHE_LIMIT = 16;

/**
 * What changes when a glossary's content does. Reading every term's
 * preferred rendering costs about 100 ms per thousand terms (it is a query
 * per term), which is too much to pay on every save; these aggregates cost
 * a scan of the three tables. Every write to a term, a variant or the
 * decision log moves one of them: rows are only added or marked deleted,
 * and an edit bumps `rev` and `updated_at`.
 */
function fingerprint(
  glossary: Database.Database,
  langs: { readonly srcLang: string; readonly tgtLang: string },
): string {
  const row = glossary
    .prepare(
      `SELECT
         (SELECT COUNT(*) || ':' || COALESCE(MAX(id), 0) FROM term_decision) AS decisions,
         (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') || ':' || COALESCE(SUM(deleted), 0)
            FROM term) AS terms,
         (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') || ':' || COALESCE(SUM(rev), 0) || ':' || COALESCE(SUM(forbidden), 0)
            FROM term_variant) AS variants`,
    )
    .get() as { decisions: string; terms: string; variants: string };
  return [langs.srcLang, langs.tgtLang, row.decisions, row.terms, row.variants].join('|');
}

/**
 * A matcher over the write-target glossary, or `undefined` when there is
 * nothing to compare against — no write target, a file that is gone, one
 * that cannot be read, or a project without a language pair. The rule is
 * then silent, as the panel's list is (`glossary: null`): QA never fails
 * an edit over a glossary, and a glossary it cannot read is the glossary
 * panel's to report.
 *
 * Opened without the migration runner's integrity check, as `peekTm` is
 * (tm-format-spec.md §10): this runs on every edit, and only a connection
 * that writes or retrieves for real verifies a file. `query_only`, not
 * `readonly: true`, which leaves `-wal`/`-shm` files behind.
 */
export function glossaryMismatchFinder(
  db: Database.Database,
  langs: { readonly srcLang: string; readonly tgtLang: string } | null | undefined,
): MismatchFinder | undefined {
  if (!langs) return undefined;
  const ref = listGlossaryRefs(db).find((r) => r.isWriteTarget && r.enabled);
  if (!ref || !existsSync(ref.path)) return undefined;
  let glossary: Database.Database | undefined;
  try {
    glossary = new Database(ref.path, { fileMustExist: true });
    glossary.pragma('query_only = ON');
    const print = fingerprint(glossary, langs);
    const hit = cache.get(ref.path);
    if (hit?.fingerprint === print) return hit.finder;
    const finder = mismatchFinder(listTermEntries(glossary, langs), langs);
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(ref.path, { fingerprint: print, finder });
    return finder;
  } catch {
    return undefined;
  } finally {
    glossary?.close();
  }
}
