import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { openAndMigrate } from '../migrate.js';
import { TmError } from './errors.js';
import {
  NORMALIZER_VERSION,
  TM_APPLICATION_ID,
  TM_MIGRATIONS,
  TOKENIZER_VERSION,
} from './schema.js';

/** Opens an existing `.ctm` file, migrating it if needed. */
export function openTm(path: string): Database.Database {
  return openAndMigrate(path, {
    applicationId: TM_APPLICATION_ID,
    migrations: TM_MIGRATIONS,
  });
}

export interface CreateTmOptions {
  /** Shown to the user; not an identity — `uuid` is. */
  readonly name: string;
  /** e.g. "cat-tool/0.3.1" (tm-format-spec.md §2.1). */
  readonly generator: string;
}

/**
 * Creates a brand-new `.ctm` file and writes its identity row.
 *
 * The `tm` table's `CHECK (id = 1)` makes a memory without an identity
 * row an incomplete file, so creation is a distinct step from opening —
 * refuses outright on a file that already has one, rather than silently
 * ignoring `options` for a memory that already exists. Use {@link openTm}
 * to open one already created.
 */
export function createTm(path: string, options: CreateTmOptions): Database.Database {
  const db = openTm(path);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM tm').get() as { n: number };
  if (n > 0) {
    db.close();
    throw new TmError(
      `"${path}" is already an initialised .ctm file — use openTm instead`,
    );
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tm
       (id, uuid, name, langs, created_at, format_version, generator,
        normalizer_version, tokenizer_version)
     VALUES (1, ?, ?, '[]', ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    options.name,
    now,
    TM_MIGRATIONS[TM_MIGRATIONS.length - 1]!.version,
    options.generator,
    NORMALIZER_VERSION,
    TOKENIZER_VERSION,
  );
  return db;
}

/** What a memory is, for a list of memories (backlog #32). */
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

export {
  NORMALIZER_VERSION,
  TM_APPLICATION_ID,
  TM_MIGRATIONS,
  TOKENIZER_VERSION,
} from './schema.js';
export * from './errors.js';
export * from './retrieve.js';
export * from './import-common.js';
export * from './import-tmx.js';
export * from './import-sdltm.js';
export * from './export-tmx.js';
export * from './write.js';
export * from './vectors.js';
