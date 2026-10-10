/**
 * Opening a `.ctm` or `.ctg` that another process owns, to read it and
 * nothing else (backlog #162).
 *
 * `openAndMigrate` is the right open for the file's own writer: it migrates,
 * backs up and checks integrity, all of which write. The portal's client
 * export reads a file the CAT server may be writing, so it must not migrate
 * it, back it up or take its write lock. A connection under `query_only`
 * (not `readonly: true`, which leaves `-wal`/`-shm` files behind a WAL
 * database, as `peekTm` explains) refuses writes at the SQL level, and the
 * format version must be exactly the newest this build writes: an older file
 * has not been migrated, so the columns the export reads may not be there,
 * and it is opened by its owner once before it is exported.
 */

import Database from 'better-sqlite3';

import type { Migration } from './migrate.js';

export interface OpenReadOnlyOptions {
  readonly applicationId: number;
  readonly migrations: readonly Migration[];
  /** What the file should be, for the message: `memory` or `glossary`. */
  readonly what: string;
}

/** A file that cannot be read for export: missing, not the right kind, or not current. */
export class ReadOnlyOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadOnlyOpenError';
  }
}

/**
 * A `query_only` connection to an existing file of the right application id
 * and the newest format version. Does not run `integrity_check` (a client
 * export is not the place to spend seconds on a large file); the caller closes it.
 */
export function openReadOnly(
  path: string,
  options: OpenReadOnlyOptions,
): Database.Database {
  let db: Database.Database;
  try {
    db = new Database(path, { fileMustExist: true });
  } catch (err) {
    throw new ReadOnlyOpenError(
      `the ${options.what} is not readable (${(err as Error).message})`,
    );
  }
  try {
    db.pragma('query_only = ON');
    let appId: number;
    let version: number;
    try {
      appId = db.pragma('application_id', { simple: true }) as number;
      version = db.pragma('user_version', { simple: true }) as number;
    } catch {
      throw new ReadOnlyOpenError(`the ${options.what} is not a database`);
    }
    const newest = options.migrations[options.migrations.length - 1]!.version;
    if (appId !== options.applicationId || version < 1) {
      throw new ReadOnlyOpenError(`the file is not a ${options.what}`);
    }
    if (version !== newest) {
      throw new ReadOnlyOpenError(
        `the ${options.what} is format version ${version}, not the ${newest} this build ` +
          'reads: open it once in the editor to bring it up to date',
      );
    }
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
