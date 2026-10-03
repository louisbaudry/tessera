/**
 * Describing a memory without opening it (backlog #95, tm-format-spec.md
 * §10). `openTm` runs `integrity_check` on every open — the §10 policy, and
 * right for anything that writes to the memory or retrieves from it — and
 * that took 7.9 s on a 500,000-unit memory. A list of memories asks for a
 * name and a count, so it takes them from a connection that checks nothing:
 * it reads the `tm` row and counts live units (40 ms at the same size),
 * and neither migrates, verifies, backs up nor writes (`query_only`).
 *
 * Not `readonly: true`, deliberately. A read-only connection to a WAL file
 * cannot remove the `-wal` and `-shm` files it makes, so every listing
 * would leave two sidecars beside every memory; an ordinary connection
 * that only reads closes as SQLite expects, and cleans up after itself.
 */

import Database from 'better-sqlite3';

import { TmError } from './errors.js';
import { describeTm, type TmSummary } from './describe.js';
import { TM_APPLICATION_ID, TM_MIGRATIONS } from './schema.js';

/**
 * A memory's summary (`describeTm`) from a read-only connection.
 *
 * Refuses what `openTm` would refuse by its header — a file that is not a
 * `.ctm`, or a newer format than this build reads — and nothing else: it
 * does **not** verify the file's integrity, so a damaged memory lists
 * normally and is caught when it is opened for use. An older format is
 * described as it is, unmigrated (`describeTm` reads only tables every
 * format version has).
 */
export function peekTm(path: string): TmSummary {
  let db: Database.Database;
  try {
    db = new Database(path, { fileMustExist: true });
  } catch (err) {
    // `fileMustExist`, and a file SQLite cannot read as a database at all.
    throw new TmError(
      `"${path}" is not a readable .ctm memory (${(err as Error).message})`,
    );
  }
  try {
    // A refusal at the SQL level, so a future edit here cannot write by accident.
    db.pragma('query_only = ON');
    let appId: number;
    let version: number;
    try {
      appId = db.pragma('application_id', { simple: true }) as number;
      version = db.pragma('user_version', { simple: true }) as number;
    } catch {
      // The open is lazy: a file that is not a database fails on this first read.
      throw new TmError(`"${path}" is not a .ctm memory`);
    }
    const newest = TM_MIGRATIONS[TM_MIGRATIONS.length - 1]!.version;
    if (appId !== TM_APPLICATION_ID || version < 1) {
      throw new TmError(`"${path}" is not a .ctm memory`);
    }
    if (version > newest) {
      throw new TmError(
        `"${path}" is format version ${version}, newer than the ${newest} this build ` +
          'understands — update the application before opening it',
      );
    }
    return describeTm(db);
  } finally {
    db.close();
  }
}
