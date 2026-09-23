/**
 * TMX 1.4b → `.ctm` import (tm-format-spec.md §8; backlog #18).
 *
 * `@cat-tool/core`'s `parseTmx` does the format decoding; this module is
 * the one place a parsed TMX document actually becomes `tu`/`tuv`/
 * `tu_attr` rows, as a single transaction so a large import never leaves
 * the file half-written.
 *
 * Deliberately *not* a merge: a `<tu>` whose restored `x-catm-uuid`
 * collides with a `uuid` already present in this file falls back to a
 * fresh one (with a warning) rather than reconciling revisions —
 * uuid/rev conflict resolution across two files is backlog #15d's job,
 * not this one's.
 */

import { randomUUID } from 'node:crypto';

import {
  normalizeTokens,
  parseTmx,
  tmxDateToIso,
  type ParsedTmxTu,
  type ParsedTmxTuv,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { DEFAULT_IMPORTED_QUALITY } from './import-common.js';
import { refreshLangs } from './write.js';

export interface ImportTmxResult {
  readonly tuCount: number;
  readonly tuvCount: number;
  readonly warnings: readonly string[];
}

function resolveUuid(
  db: Database.Database,
  findByUuid: (uuid: string) => boolean,
  tu: ParsedTmxTu,
  warnings: string[],
): string {
  if (tu.restoredUuid === undefined) return randomUUID();
  if (!findByUuid(tu.restoredUuid)) return tu.restoredUuid;
  warnings.push(
    `<tu tuid="${tu.tuid ?? ''}"> reuses uuid ${tu.restoredUuid}, already present in this ` +
      `memory — imported under a new uuid instead (merging TMs is backlog #15d, not TMX import)`,
  );
  return randomUUID();
}

/**
 * Imports every `<tu>` in a TMX document into an already-open `.ctm`
 * connection, as one transaction.
 */
export function importTmx(db: Database.Database, xml: string): ImportTmxResult {
  const parsed = parseTmx(xml);
  const warnings = [...parsed.warnings];

  const findTuByUuid = db.prepare('SELECT 1 FROM tu WHERE uuid = ?');
  const insertTu = db.prepare(
    `INSERT INTO tu (uuid, rev, created_at, updated_at, created_by)
     VALUES (@uuid, @rev, @created_at, @updated_at, @created_by)`,
  );
  const insertTuAttr = db.prepare(
    'INSERT OR REPLACE INTO tu_attr (tu_id, key, value) VALUES (?, ?, ?)',
  );
  const insertTuv = db.prepare(
    `INSERT INTO tuv
       (tu_id, lang, rev, tokens, plain, hash, prev_hash, next_hash,
        quality, usage_count, last_used_at, created_at, updated_at, updated_by)
     VALUES
       (@tu_id, @lang, @rev, @tokens, @plain, @hash, @prev_hash, @next_hash,
        @quality, @usage_count, @last_used_at, @created_at, @updated_at, @updated_by)`,
  );

  let tuCount = 0;
  let tuvCount = 0;

  const run = db.transaction(() => {
    const now = new Date().toISOString();

    for (const tu of parsed.units) {
      const uuid = resolveUuid(db, (u) => !!findTuByUuid.get(u), tu, warnings);
      const createdAt = tmxDateToIso(tu.creationdate) ?? now;
      const updatedAt = tmxDateToIso(tu.changedate) ?? createdAt;

      const info = insertTu.run({
        uuid,
        rev: tu.restoredRev ?? 1,
        created_at: createdAt,
        updated_at: updatedAt,
        created_by: tu.creationid ?? null,
      });
      const tuId = info.lastInsertRowid as number;
      tuCount++;

      if (tu.tuid !== undefined) insertTuAttr.run(tuId, 'tuid', tu.tuid);
      for (const prop of tu.props) insertTuAttr.run(tuId, prop.type, prop.value);

      for (const variant of tu.variants) {
        insertVariant(insertTuv, tuId, variant, tu, createdAt, updatedAt);
        tuvCount++;
      }
    }

    refreshLangs(db);
  });
  run();

  if (tuCount > 0) {
    warnings.push(
      'TMX-sourced units carry no context (prev_hash/next_hash) — they can never be ICE matches.',
    );
  }

  return { tuCount, tuvCount, warnings };
}

/** A TMX integer attribute, parsed leniently: absent or malformed -> `undefined`, never `NaN`. */
function parseCount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
}

function insertVariant(
  insertTuv: Database.Statement,
  tuId: number,
  variant: ParsedTmxTuv,
  tu: ParsedTmxTu,
  tuCreatedAt: string,
  tuUpdatedAt: string,
): void {
  const { plain, hash } = normalizeTokens(variant.tokens);
  const createdAt = tmxDateToIso(variant.creationdate) ?? tuCreatedAt;
  const updatedAt = tmxDateToIso(variant.changedate) ?? tuUpdatedAt;
  // TMX puts usagecount/lastusagedate on <tu> in practice (real Trados
  // exports never set them per-<tuv>), but the DTD allows either — a
  // variant's own value wins when present, the unit's is the fallback.
  const usageCount = parseCount(variant.usagecount) ?? parseCount(tu.usagecount) ?? 0;
  const lastUsedAt =
    tmxDateToIso(variant.lastusagedate) ?? tmxDateToIso(tu.lastusagedate) ?? null;

  insertTuv.run({
    tu_id: tuId,
    lang: variant.lang,
    rev: variant.restoredRev ?? 1,
    tokens: JSON.stringify(variant.tokens),
    plain,
    hash,
    // undefined -> NULL: ordinary TMX carries no context at all; a
    // restored x-catm-prev/next (our own re-imported export) is the
    // one case these are populated (tm-format-spec.md §8).
    prev_hash: variant.restoredPrevHash ?? null,
    next_hash: variant.restoredNextHash ?? null,
    quality: variant.restoredQuality ?? DEFAULT_IMPORTED_QUALITY,
    usage_count: usageCount,
    last_used_at: lastUsedAt,
    created_at: createdAt,
    updated_at: updatedAt,
    updated_by: variant.changeid ?? variant.creationid ?? null,
  });
}
