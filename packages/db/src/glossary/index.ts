import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { openAndMigrate } from '../migrate.js';
import {
  GLOSSARY_APPLICATION_ID,
  GLOSSARY_MIGRATIONS,
  NORMALIZER_VERSION,
} from './schema.js';

export class GlossaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlossaryError';
  }
}

/** Opens an existing `.ctg` file, migrating it if needed. */
export function openGlossary(path: string): Database.Database {
  return openAndMigrate(path, {
    applicationId: GLOSSARY_APPLICATION_ID,
    migrations: GLOSSARY_MIGRATIONS,
  });
}

export interface CreateGlossaryOptions {
  /** Shown to the user; not an identity — `uuid` is. */
  readonly name: string;
  /** e.g. "cat-tool/0.3.1". */
  readonly generator: string;
  /**
   * Client label, matching the TM format's reserved `client` attribute
   * key for the same client. Omit for a base glossary
   * (smart-glossary-spec.md §3.1).
   */
  readonly client?: string;
}

/**
 * Creates a brand-new `.ctg` file and writes its identity row — the
 * `createTm`/`openTm` split, for the same reason: `glossary`'s
 * `CHECK (id = 1)` makes a file without an identity row incomplete, so
 * creation refuses a file that already has one rather than silently
 * ignoring `options`.
 */
export function createGlossary(
  path: string,
  options: CreateGlossaryOptions,
): Database.Database {
  const db = openGlossary(path);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM glossary').get() as { n: number };
  if (n > 0) {
    db.close();
    throw new GlossaryError(
      `"${path}" is already an initialised .ctg file — use openGlossary instead`,
    );
  }
  db.prepare(
    `INSERT INTO glossary
       (id, uuid, name, client, langs, created_at, format_version, generator,
        normalizer_version)
     VALUES (1, ?, ?, ?, '[]', ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    options.name,
    options.client ?? null,
    new Date().toISOString(),
    GLOSSARY_MIGRATIONS[GLOSSARY_MIGRATIONS.length - 1]!.version,
    options.generator,
    NORMALIZER_VERSION,
  );
  return db;
}

export { GLOSSARY_APPLICATION_ID, GLOSSARY_MIGRATIONS } from './schema.js';
export * from './terms.js';
