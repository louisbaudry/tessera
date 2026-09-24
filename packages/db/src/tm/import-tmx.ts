/**
 * TMX 1.4b → `.ctm` import (tm-format-spec.md §8; backlog #18, #18c).
 *
 * `@cat-tool/core`'s `TmxStreamParser` does the format decoding; this
 * module is the one place a parsed `<tu>` actually becomes `tu`/`tuv`/
 * `tu_attr` rows. Two entry points share one writer:
 *
 * - `importTmx(db, xml)` — a document already in memory, one
 *   transaction, all-or-nothing.
 * - `importTmxFile(db, path)` — a file of any size, read in chunks and
 *   written in batches, each batch one transaction that also advances
 *   the file's `tm_import` row (§2.9). An interrupted import leaves
 *   whole units and a visible incomplete state; `resume` continues it.
 *   Why batches rather than one transaction is recorded in §12.4.
 *
 * Deliberately *not* a merge: a `<tu>` whose restored `x-catm-uuid`
 * collides with a `uuid` already present in this file falls back to a
 * fresh one (with a warning) rather than reconciling revisions —
 * uuid/rev conflict resolution across two files is backlog #15d's job,
 * not this one's.
 */

import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { basename } from 'node:path';

import {
  normalizeTokens,
  tmxDateToIso,
  TmxStreamParser,
  type ParsedTmxTu,
  type ParsedTmxTuv,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { TmError } from './errors.js';
import { DEFAULT_IMPORTED_QUALITY } from './import-common.js';
import { refreshLangs } from './write.js';

export interface ImportTmxResult {
  /** The `tm_import` row this run wrote (§2.9). */
  readonly importId: number;
  /** Units written by this call — excludes any a resume skipped. */
  readonly tuCount: number;
  readonly tuvCount: number;
  readonly warnings: readonly string[];
}

/** One row of `tm_import` (tm-format-spec.md §2.9). */
export interface TmImport {
  readonly id: number;
  readonly format: 'tmx';
  readonly sourceName: string;
  readonly sourceBytes: number;
  readonly startedAt: string;
  /** `null` while the import is incomplete. */
  readonly finishedAt: string | null;
  readonly unitsDone: number;
  readonly variantsDone: number;
}

export interface ImportTmxFileOptions {
  /**
   * Units per transaction. Bounds what is held in memory (one batch of
   * parsed units) and what an interruption can lose (one batch).
   */
  readonly batchSize?: number;
  /**
   * The id of an incomplete `tm_import` row to continue: its first
   * `unitsDone` units are parsed and skipped, the rest written. Refused
   * if the row is finished, or the file's size differs from the one it
   * recorded.
   */
  readonly resume?: number;
  /** Bytes read per chunk; only tests need to set it, to force chunk boundaries mid-character. */
  readonly chunkBytes?: number;
}

export const DEFAULT_IMPORT_BATCH_SIZE = 10_000;

/** Bytes read per chunk. Independent of batch size; only the parser's tail and one batch are ever held. */
const DEFAULT_CHUNK_BYTES = 1 << 20;

const ICE_WARNING =
  'TMX-sourced units carry no context (prev_hash/next_hash) — they can never be ICE matches.';

interface TmImportRow {
  id: number;
  format: 'tmx';
  source_name: string;
  source_bytes: number;
  started_at: string;
  finished_at: string | null;
  units_done: number;
  variants_done: number;
}

function fromRow(row: TmImportRow): TmImport {
  return {
    id: row.id,
    format: row.format,
    sourceName: row.source_name,
    sourceBytes: row.source_bytes,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    unitsDone: row.units_done,
    variantsDone: row.variants_done,
  };
}

/** Every import this memory has recorded, oldest first — incomplete ones included, and visible. */
export function listTmImports(db: Database.Database): TmImport[] {
  return (db.prepare('SELECT * FROM tm_import ORDER BY id').all() as TmImportRow[]).map(
    fromRow,
  );
}

function getTmImport(db: Database.Database, id: number): TmImport | undefined {
  const row = db.prepare('SELECT * FROM tm_import WHERE id = ?').get(id) as
    TmImportRow | undefined;
  return row ? fromRow(row) : undefined;
}

/**
 * Imports every `<tu>` in a TMX document into an already-open `.ctm`
 * connection, as one transaction — the single-batch case of
 * {@link importTmxFile}, for a document small enough to be a string.
 */
export function importTmx(db: Database.Database, xml: string): ImportTmxResult {
  const parser = new TmxStreamParser();
  const units = parser.push(xml);
  parser.end();

  const writer = new UnitWriter(db);
  const importId = db.transaction(() => {
    const id = startImport(db, 'inline.tmx', Buffer.byteLength(xml, 'utf8'));
    writer.writeBatch(id, units, true);
    return id;
  })();
  return result(importId, writer, parser);
}

/**
 * Imports a TMX file of any size into an already-open `.ctm` connection,
 * reading it in chunks and committing every `batchSize` units, so memory
 * stays bounded however large the file is (backlog #18c).
 *
 * Synchronous, like every repository call here: running it off the
 * request thread is the caller's job (§1.1, backlog #16a). Nothing else
 * may write through this connection while it runs.
 *
 * If it throws after a batch committed, the memory keeps those units and
 * its `tm_import` row stays incomplete (`finishedAt: null`); pass that
 * row's id as `resume` to continue after the last committed unit.
 */
export function importTmxFile(
  db: Database.Database,
  path: string,
  options: ImportTmxFileOptions = {},
): ImportTmxResult {
  const batchSize = options.batchSize ?? DEFAULT_IMPORT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new TmError(`batchSize must be a positive integer, got ${batchSize}`);
  }
  const fd = openSync(path, 'r');
  try {
    const sourceBytes = fstatSync(fd).size;
    const importId = options.resume ?? startImport(db, basename(path), sourceBytes);
    let skip = 0;
    if (options.resume !== undefined) {
      const run = getTmImport(db, options.resume);
      if (!run)
        throw new TmError(`no import #${options.resume} in this memory to resume`);
      if (run.finishedAt !== null) {
        throw new TmError(
          `import #${run.id} finished at ${run.finishedAt} — nothing to resume`,
        );
      }
      if (run.sourceBytes !== sourceBytes) {
        throw new TmError(
          `import #${run.id} was of a ${run.sourceBytes}-byte file; ${path} is ` +
            `${sourceBytes} bytes — not the same file, so not resumable`,
        );
      }
      skip = run.unitsDone;
    }

    const parser = new TmxStreamParser();
    const writer = new UnitWriter(db);
    const decoder = new TextDecoder('utf-8');
    const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    const chunk = Buffer.allocUnsafe(chunkBytes);
    let pending: ParsedTmxTu[] = [];
    let seen = 0;

    const take = (units: ParsedTmxTu[]): void => {
      for (const unit of units) {
        if (seen++ < skip) continue;
        pending.push(unit);
        if (pending.length >= batchSize) {
          db.transaction(() => writer.writeBatch(importId, pending, false))();
          pending = [];
        }
      }
    };

    for (;;) {
      const n = readSync(fd, chunk, 0, chunkBytes, null);
      if (n === 0) break;
      take(parser.push(decoder.decode(chunk.subarray(0, n), { stream: true })));
    }
    take(parser.push(decoder.decode()));
    parser.end();
    if (seen < skip) {
      throw new TmError(
        `import #${importId} had already written ${skip} units, but ${path} holds only ` +
          `${seen} — not the same file, so not resumable`,
      );
    }
    db.transaction(() => writer.writeBatch(importId, pending, true))();
    return result(importId, writer, parser);
  } finally {
    closeSync(fd);
  }
}

function startImport(
  db: Database.Database,
  sourceName: string,
  sourceBytes: number,
): number {
  return db
    .prepare(
      `INSERT INTO tm_import (format, source_name, source_bytes, started_at)
       VALUES ('tmx', ?, ?, ?)`,
    )
    .run(sourceName, sourceBytes, new Date().toISOString()).lastInsertRowid as number;
}

function result(
  importId: number,
  writer: UnitWriter,
  parser: TmxStreamParser,
): ImportTmxResult {
  const warnings = [...parser.warnings(), ...writer.warnings()];
  if (writer.tuCount > 0) warnings.push(ICE_WARNING);
  return { importId, tuCount: writer.tuCount, tuvCount: writer.tuvCount, warnings };
}

/**
 * Writes parsed units into `tu`/`tuv`/`tu_attr`. Holds its prepared
 * statements and running totals across batches; the caller owns the
 * transaction each batch runs in.
 */
class UnitWriter {
  tuCount = 0;
  tuvCount = 0;
  private reusedUuids = 0;
  private firstReused: { tuid: string; uuid: string } | undefined;

  private readonly findTuByUuid: Database.Statement;
  private readonly insertTu: Database.Statement;
  private readonly insertTuAttr: Database.Statement;
  private readonly insertTuv: Database.Statement;
  private readonly advanceImport: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.findTuByUuid = db.prepare('SELECT 1 FROM tu WHERE uuid = ?');
    this.insertTu = db.prepare(
      `INSERT INTO tu (uuid, rev, created_at, updated_at, created_by)
       VALUES (@uuid, @rev, @created_at, @updated_at, @created_by)`,
    );
    this.insertTuAttr = db.prepare(
      'INSERT OR REPLACE INTO tu_attr (tu_id, key, value) VALUES (?, ?, ?)',
    );
    this.insertTuv = db.prepare(
      `INSERT INTO tuv
         (tu_id, lang, rev, tokens, plain, hash, prev_hash, next_hash,
          quality, usage_count, last_used_at, created_at, updated_at, updated_by)
       VALUES
         (@tu_id, @lang, @rev, @tokens, @plain, @hash, @prev_hash, @next_hash,
          @quality, @usage_count, @last_used_at, @created_at, @updated_at, @updated_by)`,
    );
    this.advanceImport = db.prepare(
      `UPDATE tm_import
       SET units_done = units_done + @units, variants_done = variants_done + @variants,
           finished_at = CASE WHEN @finished THEN @now ELSE NULL END
       WHERE id = @id`,
    );
  }

  /** Must run inside a transaction: the units and their progress commit together or not at all. */
  writeBatch(importId: number, units: readonly ParsedTmxTu[], finished: boolean): void {
    const now = new Date().toISOString();
    const tuvBefore = this.tuvCount;
    for (const tu of units) this.writeUnit(tu, now);
    this.advanceImport.run({
      id: importId,
      units: units.length,
      variants: this.tuvCount - tuvBefore,
      finished: finished ? 1 : 0,
      now,
    });
    refreshLangs(this.db);
  }

  /** One line for every reused uuid, not one per unit (CLAUDE.md's per-occurrence gotcha). */
  warnings(): string[] {
    if (this.reusedUuids === 0) return [];
    const { tuid, uuid } = this.firstReused!;
    return [
      `${this.reusedUuids} <tu> reuses uuid(s) already present in this memory (first: ` +
        `<tu tuid="${tuid}"> with ${uuid}) — imported under new uuids instead (merging TMs ` +
        'is backlog #15d, not TMX import)',
    ];
  }

  private resolveUuid(tu: ParsedTmxTu): string {
    if (tu.restoredUuid === undefined) return randomUUID();
    if (!this.findTuByUuid.get(tu.restoredUuid)) return tu.restoredUuid;
    this.reusedUuids++;
    this.firstReused ??= { tuid: tu.tuid ?? '', uuid: tu.restoredUuid };
    return randomUUID();
  }

  private writeUnit(tu: ParsedTmxTu, now: string): void {
    const createdAt = tmxDateToIso(tu.creationdate) ?? now;
    const updatedAt = tmxDateToIso(tu.changedate) ?? createdAt;
    const info = this.insertTu.run({
      uuid: this.resolveUuid(tu),
      rev: tu.restoredRev ?? 1,
      created_at: createdAt,
      updated_at: updatedAt,
      created_by: tu.creationid ?? null,
    });
    const tuId = info.lastInsertRowid as number;
    this.tuCount++;

    if (tu.tuid !== undefined) this.insertTuAttr.run(tuId, 'tuid', tu.tuid);
    for (const prop of tu.props) this.insertTuAttr.run(tuId, prop.type, prop.value);

    for (const variant of tu.variants) {
      insertVariant(this.insertTuv, tuId, variant, tu, createdAt, updatedAt);
      this.tuvCount++;
    }
  }
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
