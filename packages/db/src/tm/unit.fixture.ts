/**
 * Test scaffolding: inserts one translation unit straight into a `.ctm`, with
 * the variants a test names and nothing derived beyond `plain` and a stand-in
 * hash. For tests of the readers (`concordance.ts`, `fuzzy.ts`'s kin) that care
 * about what is stored, not about how a write path normalises it.
 */
import type Database from 'better-sqlite3';

import { normalizeText } from '@cat-tool/core';

/** One unit with the given variants; later calls get later ids, so they are "newer". */
export function unit(
  db: Database.Database,
  variants: ReadonlyArray<{ lang: string; text: string; quality?: number }>,
  deleted = false,
): number {
  const now = new Date().toISOString();
  const tuId = db
    .prepare('INSERT INTO tu (uuid, created_at, updated_at, deleted) VALUES (?, ?, ?, ?)')
    .run(`u${Math.random()}`, now, now, deleted ? 1 : 0).lastInsertRowid as number;
  for (const v of variants) {
    const plain = normalizeText(v.text);
    db.prepare(
      `INSERT INTO tuv (tu_id, lang, tokens, plain, hash, quality, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      tuId,
      v.lang,
      JSON.stringify([{ t: 'text', v: v.text }]),
      plain,
      `h:${v.lang}:${plain}`,
      v.quality ?? 1,
      now,
      now,
    );
  }
  return tuId;
}
