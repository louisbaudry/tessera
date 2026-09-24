/**
 * Region-insensitive language matching in SQL, shared by every
 * repository that looks a language up in a `(lang, …)` index — TM pair
 * retrieval (`tm/retrieve.ts`) and glossary term lookup
 * (`glossary/terms.ts`). Backlog #19a.
 *
 * "`es-ES` matches `es`" is `primary_subtag(lang) = primary_subtag(?)`,
 * but written that way against the indexed column it wraps `lang` in a
 * function, and SQLite can no longer seek the index: every lookup scans
 * the whole table and calls into JS once per row (161 ms at 100k TM
 * units, 1.7 s at 1M — tm-format-spec.md §11.2). `matchingLangs` turns
 * the same condition into `lang IN (…)` over the handful of *stored*
 * language tags that satisfy it, which the index can seek on.
 */

import type Database from 'better-sqlite3';

import { primarySubtag } from '@cat-tool/core';

const registeredPrimarySubtagFn = new WeakSet<Database.Database>();

/**
 * `primary_subtag(lang)` as a SQL scalar function, so the region-
 * insensitive match condition can live in the query instead of pulling
 * every candidate row into JS to filter. Registered once per connection
 * — `better-sqlite3` throws if the same function name is registered
 * twice on one `Database`.
 */
export function ensurePrimarySubtagFn(db: Database.Database): void {
  if (registeredPrimarySubtagFn.has(db)) return;
  db.function('primary_subtag', { deterministic: true }, (lang: unknown) =>
    primarySubtag(String(lang)),
  );
  registeredPrimarySubtagFn.add(db);
}

/**
 * A `SELECT` yielding every distinct `lang` stored in `table`, one row
 * each, in ascending order — read from the table's own index by a
 * recursive loose index scan: one seek per distinct language, so its
 * cost is O(languages × log rows) however large the table grows, where
 * `SELECT DISTINCT lang` walks every index entry (backlog #20a: 247 ms
 * at 1M TM units). The ordering is the recursion's own: each step seeks
 * the smallest `lang` above the previous one.
 *
 * `table` must already be schema-qualified (`qualifySchema`) and must
 * have an index whose first column is `lang` — without one each step is
 * a full scan, which is worse than `DISTINCT`, not better. It is this
 * codebase's own string, never request input.
 */
export function distinctLangs(table: string): string {
  return `WITH RECURSIVE present(lang) AS (
             SELECT MIN(lang) FROM ${table}
             UNION ALL
             SELECT (SELECT MIN(lang) FROM ${table} WHERE lang > present.lang)
             FROM   present WHERE present.lang IS NOT NULL)
           SELECT lang FROM present WHERE lang IS NOT NULL`;
}

/**
 * A parenthesised subquery yielding every distinct `lang` stored in
 * `table` whose primary subtag equals that of the bound parameter
 * `param` — for use as `col IN ${matchingLangs(…)}`.
 *
 * The distinct languages come from `distinctLangs`, so the result is
 * always exactly what the table holds. That is deliberate:
 * `tm.langs`/`glossary.langs` already list the same thing, but they are
 * a denormalised projection maintained by the write paths, and a lookup
 * that trusted one would silently miss every row a stale projection
 * left out. The cost of not trusting it is a few extra seeks per lookup.
 *
 * `table` has `distinctLangs`'s requirements; `param` is a named
 * parameter such as `@srcLang`, again this codebase's own string. Call
 * `ensurePrimarySubtagFn` on the connection first.
 */
export function matchingLangs(table: string, param: string): string {
  return `(${distinctLangs(table)}
             AND primary_subtag(lang) = primary_subtag(${param}))`;
}
