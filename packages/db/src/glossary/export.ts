/**
 * A glossary's current terms as the rows of a client export (backlog #162;
 * the CSV itself is `core`'s `glossaryCsv`).
 *
 * Reads only the live terms and their variants. The decision log, notes and
 * `updated_by` are never read, so they cannot leave. `status` is the same
 * derivation the editor uses: `preferredVariant` per (term, language), a
 * forbidden variant is `forbidden`, every other is `allowed`.
 */

import type { GlossaryExportRow } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { preferredVariant } from './terms.js';

interface VariantRow {
  id: number;
  term_id: number;
  lang: string;
  text: string;
  forbidden: number;
}

/** One row per rendering of every non-tombstoned term, grouped by term, in term then variant order. */
export function exportGlossaryRows(db: Database.Database): GlossaryExportRow[] {
  const variants = db
    .prepare(
      `SELECT v.id, v.term_id, v.lang, v.text, v.forbidden FROM term_variant v
       JOIN term t ON t.id = v.term_id AND t.deleted = 0
       ORDER BY v.term_id, v.id`,
    )
    .all() as VariantRow[];

  const rows: GlossaryExportRow[] = [];
  let concept = 0;
  let current = -1;
  const preferred = new Map<string, number | null>();
  for (const v of variants) {
    if (v.term_id !== current) {
      current = v.term_id;
      concept++;
    }
    const key = `${v.term_id}\u0000${v.lang}`;
    if (!preferred.has(key)) {
      preferred.set(key, preferredVariant(db, v.term_id, v.lang)?.id ?? null);
    }
    rows.push({
      concept,
      lang: v.lang,
      term: v.text,
      status: v.forbidden
        ? 'forbidden'
        : preferred.get(key) === v.id
          ? 'preferred'
          : 'allowed',
    });
  }
  return rows;
}
