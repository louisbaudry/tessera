/**
 * What a memory is, for a list of memories (backlog #32). Its own module,
 * not `index.ts`'s: `peek.ts` needs it, and a module the barrel re-exports
 * must not import the barrel back (`errors.ts` says why).
 */

import type Database from 'better-sqlite3';

import { TmError } from './errors.js';

export interface TmSummary {
  readonly uuid: string;
  /** Shown to the user; not an identity — `uuid` is. */
  readonly name: string;
  /** Every language a live variant is in (`tm.langs`, tm-format-spec.md §2.1). */
  readonly langs: readonly string[];
  /** Live units; tombstones (§9) are not counted. */
  readonly units: number;
  readonly createdAt: string;
}

/** A `.ctm`'s identity row and size. */
export function describeTm(db: Database.Database): TmSummary {
  const row = db
    .prepare('SELECT uuid, name, langs, created_at FROM tm WHERE id = 1')
    .get() as
    { uuid: string; name: string; langs: string; created_at: string } | undefined;
  if (!row) throw new TmError('memory has no identity row');
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM tu WHERE deleted = 0').get() as {
    n: number;
  };
  return {
    uuid: row.uuid,
    name: row.name,
    langs: JSON.parse(row.langs) as string[],
    units: n,
    createdAt: row.created_at,
  };
}
