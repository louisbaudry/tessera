/**
 * Correcting or retiring one unit of a `.ctm` (`v1-spec.md` §6.1c; issue #151):
 * the manual edit `write.ts` says a future feature would call, as two small
 * writes beside `writeBack` rather than raw SQL in a route.
 *
 * `editUnitTarget` replaces one variant's text; `retireUnit` tombstones the
 * unit (`tm-format-spec.md` §7). Neither deletes a row. A `.ctm` has no audit
 * log, so what is kept here is the memory's own: `tuv_history` for an edit and
 * two `tu_attr` keys for a retirement; the event that names the project is
 * `project/memory-units.ts`'s.
 */

import { normalizeTokens, xmlLegalText } from '@cat-tool/core';
import type { TmToken } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { qualifySchema } from '../schema-alias.js';
import { QUALITY } from './schema.js';

/** Why a unit could not be edited or retired, for a caller that maps it to an answer. */
export type UnitEditFailure =
  'not_found' | 'stale' | 'tagged' | 'blank' | 'too_long' | 'read_only';

/** The longest translation a text edit accepts: a segment, not a document. */
export const MAX_UNIT_TEXT_CHARS = 5000;

export class UnitEditError extends Error {
  constructor(
    readonly reason: UnitEditFailure,
    message: string,
  ) {
    super(message);
    this.name = 'UnitEditError';
  }
}

export interface UnitEditOptions {
  /** Schema alias of an `ATTACH`ed `.ctm`; omitted for the main database. */
  readonly schema?: string;
}

export interface EditUnitParams {
  /** The variant to correct: the one a concordance hit named. */
  readonly tuvId: number;
  /** The variant's `rev` when it was read; a different one is {@link UnitEditError} `stale`. */
  readonly baseRev: number;
  readonly text: string;
  /** Who made the change, as the memory records it (`changed_by`); a label, never an id. */
  readonly changedBy: string | null;
}

export interface EditUnitResult {
  readonly tuId: number;
  readonly tuUuid: string;
  readonly lang: string;
  readonly fromRev: number;
  readonly toRev: number;
  /** False when the text was already what was asked for: nothing is written. */
  readonly changed: boolean;
}

interface VariantRow {
  tuv_id: number;
  tu_id: number;
  tu_uuid: string;
  deleted: number;
  lang: string;
  rev: number;
  tokens: string;
  plain: string;
  quality: number;
}

function readOnly(db: Database.Database, q: string): boolean {
  const row = db.prepare(`SELECT read_only FROM ${q}tm WHERE id = 1`).get() as
    { read_only: number } | undefined;
  return row?.read_only === 1;
}

/**
 * Replaces one variant's text, keeping what it was. The variant's tokens become
 * one text token, so a variant that holds tags is refused (`tagged`): they would
 * be lost without a word. The previous tokens always go to `tuv_history` at their
 * `rev` (unlike `writeBack`, whose same-text confirm loses nothing: a person's
 * correction always does), then `rev` moves on and `quality` is raised to at
 * least `confirmed`. A stored vector of the old text is dropped, as `writeBack`
 * does, since it describes something no longer there.
 *
 * One transaction. Throws {@link UnitEditError}: `not_found` (no such variant, or
 * its unit is retired), `read_only`, `stale`, `tagged`, `blank`, `too_long`.
 */
export function editUnitTarget(
  db: Database.Database,
  params: EditUnitParams,
  options: UnitEditOptions = {},
): EditUnitResult {
  const q = qualifySchema(options.schema);
  const text = xmlLegalText(params.text).trim();
  if (text === '') throw new UnitEditError('blank', 'the translation is empty');
  if (text.length > MAX_UNIT_TEXT_CHARS) {
    throw new UnitEditError(
      'too_long',
      `a translation is at most ${MAX_UNIT_TEXT_CHARS} characters`,
    );
  }
  const tokens: TmToken[] = [{ t: 'text', v: text }];
  const { plain, hash } = normalizeTokens(tokens);

  return db.transaction((): EditUnitResult => {
    if (readOnly(db, q)) throw new UnitEditError('read_only', 'this memory is read-only');
    const row = db
      .prepare<[number], VariantRow>(
        `SELECT v.id AS tuv_id, v.tu_id AS tu_id, u.uuid AS tu_uuid, u.deleted AS deleted,
                v.lang AS lang, v.rev AS rev, v.tokens AS tokens, v.plain AS plain,
                v.quality AS quality
         FROM   ${q}tuv v JOIN ${q}tu u ON u.id = v.tu_id
         WHERE  v.id = ?`,
      )
      .get(params.tuvId);
    if (!row || row.deleted === 1) {
      throw new UnitEditError('not_found', 'no such unit in this memory');
    }
    if (row.rev !== params.baseRev) {
      throw new UnitEditError('stale', 'the unit was changed since it was read');
    }
    const previous = JSON.parse(row.tokens) as TmToken[];
    if (previous.some((t) => t.t !== 'text')) {
      throw new UnitEditError(
        'tagged',
        'this translation holds tags, which a text edit would lose',
      );
    }
    const base = {
      tuId: row.tu_id,
      tuUuid: row.tu_uuid,
      lang: row.lang,
      fromRev: row.rev,
    };
    const [only] = previous;
    if (
      row.plain === plain &&
      previous.length === 1 &&
      only?.t === 'text' &&
      only.v === text
    ) {
      return { ...base, toRev: row.rev, changed: false };
    }

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO ${q}tuv_history (tuv_id, rev, tokens, quality, changed_at, changed_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.tuv_id, row.rev, row.tokens, row.quality, now, params.changedBy);
    db.prepare(`DELETE FROM ${q}tuv_vec WHERE tuv_id = ?`).run(row.tuv_id);
    const toRev = row.rev + 1;
    db.prepare(
      `UPDATE ${q}tuv
       SET rev = @rev, tokens = @tokens, plain = @plain, hash = @hash,
           quality = @quality, updated_at = @now, updated_by = @by
       WHERE id = @id`,
    ).run({
      id: row.tuv_id,
      rev: toRev,
      tokens: JSON.stringify(tokens),
      plain,
      hash,
      quality: Math.max(row.quality, QUALITY.confirmed),
      now,
      by: params.changedBy,
    });
    return { ...base, toRev, changed: true };
  })();
}

export interface RetireUnitParams {
  /** A variant of the unit to retire: the one a concordance hit named. */
  readonly tuvId: number;
  /** That variant's `rev` when it was read; a different one is `stale`. */
  readonly baseRev: number;
  readonly changedBy: string | null;
}

export interface RetireUnitResult {
  readonly tuId: number;
  readonly tuUuid: string;
  /** False when the unit was already retired: nothing is written. */
  readonly changed: boolean;
}

/**
 * Tombstones a unit: `tu.deleted = 1`, with `rev` and `updated_at` moved, which is
 * the §7 tombstone: retrieval, fuzzy and concordance skip it, a merge never
 * resurrects it, and only compaction removes the rows. Who retired it and when are
 * `tu_attr` keys `x-retired-by` and `x-retired-at` (a unit has no `updated_by`).
 * Retiring a retired unit is a no-op, so a double click is harmless.
 *
 * One transaction. Throws {@link UnitEditError}: `not_found`, `read_only`, `stale`.
 */
export function retireUnit(
  db: Database.Database,
  params: RetireUnitParams,
  options: UnitEditOptions = {},
): RetireUnitResult {
  const q = qualifySchema(options.schema);
  return db.transaction((): RetireUnitResult => {
    if (readOnly(db, q)) throw new UnitEditError('read_only', 'this memory is read-only');
    const row = db
      .prepare<[number], VariantRow>(
        `SELECT v.id AS tuv_id, v.tu_id AS tu_id, u.uuid AS tu_uuid, u.deleted AS deleted,
                v.lang AS lang, v.rev AS rev, v.tokens AS tokens, v.plain AS plain,
                v.quality AS quality
         FROM   ${q}tuv v JOIN ${q}tu u ON u.id = v.tu_id
         WHERE  v.id = ?`,
      )
      .get(params.tuvId);
    if (!row) throw new UnitEditError('not_found', 'no such unit in this memory');
    const base = { tuId: row.tu_id, tuUuid: row.tu_uuid };
    if (row.deleted === 1) return { ...base, changed: false };
    if (row.rev !== params.baseRev) {
      throw new UnitEditError('stale', 'the unit was changed since it was read');
    }
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE ${q}tu SET deleted = 1, rev = rev + 1, updated_at = ? WHERE id = ?`,
    ).run(now, row.tu_id);
    const attr = db.prepare(
      `INSERT INTO ${q}tu_attr (tu_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT (tu_id, key) DO UPDATE SET value = excluded.value`,
    );
    attr.run(row.tu_id, 'x-retired-at', now);
    if (params.changedBy !== null) attr.run(row.tu_id, 'x-retired-by', params.changedBy);
    return { ...base, changed: true };
  })();
}
