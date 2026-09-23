/**
 * `qa_untranslated_allowlist` repository — per-project `seg.untranslated`
 * suppression, keyed by `source_hash` (v1-spec.md §6.4; backlog #23).
 *
 * Presence-based, the opposite of `qa-settings.ts`'s `qa_rule_setting`: a
 * row means "suppressed," no row means the rule runs normally for that
 * source. Keyed by `source_hash`, not segment id, so allow-listing one
 * occurrence of a legitimately-identical source (a brand name, a code
 * snippet) covers every other segment with that same normalised source,
 * with no per-occurrence bookkeeping.
 */

import type Database from 'better-sqlite3';

export function isUntranslatedAllowed(
  db: Database.Database,
  sourceHash: string,
): boolean {
  const row = db
    .prepare('SELECT 1 FROM qa_untranslated_allowlist WHERE source_hash = ?')
    .get(sourceHash);
  return row !== undefined;
}

export function addUntranslatedAllowlistEntry(
  db: Database.Database,
  sourceHash: string,
): void {
  db.prepare(
    `INSERT INTO qa_untranslated_allowlist (source_hash, added_at)
     VALUES (@source_hash, @added_at)
     ON CONFLICT (source_hash) DO NOTHING`,
  ).run({ source_hash: sourceHash, added_at: new Date().toISOString() });
}

export function removeUntranslatedAllowlistEntry(
  db: Database.Database,
  sourceHash: string,
): void {
  db.prepare('DELETE FROM qa_untranslated_allowlist WHERE source_hash = ?').run(
    sourceHash,
  );
}

export interface UntranslatedAllowlistEntry {
  readonly sourceHash: string;
  readonly addedAt: string;
}

export function listUntranslatedAllowlist(
  db: Database.Database,
): UntranslatedAllowlistEntry[] {
  const rows = db
    .prepare(
      'SELECT source_hash, added_at FROM qa_untranslated_allowlist ORDER BY added_at',
    )
    .all() as { source_hash: string; added_at: string }[];
  return rows.map((row) => ({ sourceHash: row.source_hash, addedAt: row.added_at }));
}
