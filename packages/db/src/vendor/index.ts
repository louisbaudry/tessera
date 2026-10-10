import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { openAndMigrate } from '../migrate.js';
import { VendorError } from './error.js';
import { VENDOR_APPLICATION_ID, VENDOR_MIGRATIONS } from './schema.js';

/** Opens an existing `.ctv` file, migrating it if needed. */
export function openVendorFile(path: string): Database.Database {
  return openAndMigrate(path, {
    applicationId: VENDOR_APPLICATION_ID,
    migrations: VENDOR_MIGRATIONS,
  });
}

export interface CreateVendorFileOptions {
  /** e.g. "cat-tool/0.3.1". */
  readonly generator: string;
}

/**
 * Creates a brand-new `.ctv` and writes its identity row — the
 * `createGlossary`/`openGlossary` split, for the same reason: `vendor_file`'s
 * `CHECK (id = 1)` makes a file without one incomplete, so creation
 * refuses a file that already has one rather than ignoring `options`.
 */
export function createVendorFile(
  path: string,
  options: CreateVendorFileOptions,
): Database.Database {
  const db = openVendorFile(path);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM vendor_file').get() as {
    n: number;
  };
  if (n > 0) {
    db.close();
    throw new VendorError(
      `"${path}" is already an initialised .ctv file — use openVendorFile instead`,
    );
  }
  db.prepare(
    `INSERT INTO vendor_file (id, uuid, created_at, format_version, generator)
     VALUES (1, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    new Date().toISOString(),
    VENDOR_MIGRATIONS[VENDOR_MIGRATIONS.length - 1]!.version,
    options.generator,
  );
  return db;
}

export { VendorError } from './error.js';
export { VENDOR_APPLICATION_ID, VENDOR_MIGRATIONS } from './schema.js';
export * from './vendors.js';
export * from './rates.js';
export * from './capacity.js';
export * from './assignments.js';
export * from './payable.js';
export * from './feed.js';
export * from './review.js';
export * from './delivery.js';
export * from './reconcile.js';
export * from './payments.js';
export * from './record.js';
export * from './webhooks.js';
export * from './deadlines.js';
