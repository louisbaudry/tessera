/**
 * Versioned migration runner, shared by every SQLite file this product
 * writes — the project database and the `.ctm` TM format alike
 * (`tm-format-spec.md` §9, §10; `v1-spec.md` §4.1, backlog #15).
 *
 * A translator's project and translation memory are not reconstructible,
 * so this runner is built around one rule: never partially read a file it
 * is unsure about. A future format version is refused outright, and a
 * migration on an existing file is preceded by a backup, always.
 *
 * **A migration's DDL is a historical snapshot and never reads a live
 * list** (backlog #64). A migration runs once per file, so an existing
 * file keeps whatever it created then, while a fresh file runs the same
 * migration with today's code. A `CHECK (x IN (...))` built from a
 * constant such as `QA_RULES` therefore means one thing in a new file
 * and another in every old one, and a member added later is rejected
 * everywhere except in files nobody has used yet. So each closed-set
 * CHECK is written from a literal in the migration itself; the constant
 * in `core` stays the one definition, and the literals are snapshots of
 * it. `db/check-lists.test.ts` ties the newest snapshot of each list to
 * its constant, and an ESLint rule keeps the constants out of every
 * `schema.ts`. Adding a member is a new migration that widens the CHECK
 * with {@link rebuildTable}. Don't "fix" a literal back into an import:
 * that is the bug, not a duplicate.
 */

import { copyFileSync } from 'node:fs';

import Database from 'better-sqlite3';

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

/**
 * One schema step. `version` is the `user_version` this migration
 * produces, not an index — migrations must be supplied in ascending
 * order, contiguous from 1, so "how far behind is this file" is always
 * an unambiguous integer subtraction.
 */
export interface Migration {
  readonly version: number;
  readonly description: string;
  readonly up: (db: Database.Database) => void;
}

export interface OpenOptions {
  /** Identifies the file type; stored in the SQLite header (`application_id`). */
  readonly applicationId: number;
  /** Ascending, contiguous from 1. The last entry's version is the file's current format version. */
  readonly migrations: readonly Migration[];
  /**
   * Where to copy an existing file before migrating it. Defaults to
   * `<path>.bak-v<fromVersion>-<timestamp>` beside the original.
   */
  readonly backupPath?: (path: string, fromVersion: number, now: Date) => string;
  /** Injectable for tests; defaults to the real clock. */
  readonly now?: () => Date;
}

function assertContiguous(migrations: readonly Migration[]): void {
  if (migrations.length === 0) {
    throw new MigrationError('openAndMigrate needs at least one migration');
  }
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new MigrationError(
        `migrations must be ordered and contiguous from 1; found version ` +
          `${m.version} at position ${i + 1}`,
      );
    }
  });
}

function defaultBackupPath(path: string, fromVersion: number, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `${path}.bak-v${fromVersion}-${stamp}`;
}

/** Reads a single-value pragma, e.g. `application_id` or `user_version`. */
function readPragmaInt(db: Database.Database, name: string): number {
  return db.pragma(name, { simple: true }) as number;
}

/**
 * Opens a SQLite file, verifying and migrating it as needed, and returns
 * the ready-to-use handle. The caller owns closing it.
 *
 * - A brand-new file (default `application_id`/`user_version` of 0) is
 *   claimed for this file type and brought fully up to date.
 * - A file already claimed by a *different* `application_id` is refused —
 *   opening the wrong file type is a bug, not a migration.
 * - A file whose `user_version` is higher than the newest migration this
 *   build knows is refused. This build is too old to read it safely, and
 *   guessing is exactly the failure this format exists to avoid.
 * - A file behind the newest migration is backed up (a byte-for-byte copy
 *   of the WAL-checkpointed file, so nothing recent is left behind in the
 *   WAL) and then migrated, one version at a time, each in its own
 *   transaction.
 * - `integrity_check` always runs before the handle is returned, and a
 *   failure is thrown, never swallowed.
 */
export function openAndMigrate(path: string, options: OpenOptions): Database.Database {
  assertContiguous(options.migrations);
  const targetVersion = options.migrations[options.migrations.length - 1]!.version;
  const now = options.now ?? (() => new Date());
  const backupPath = options.backupPath ?? defaultBackupPath;

  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');

    const storedAppId = readPragmaInt(db, 'application_id');
    if (storedAppId !== 0 && storedAppId !== options.applicationId) {
      throw new MigrationError(
        `"${path}" is not one of ours (application_id ${storedAppId}, ` +
          `expected ${options.applicationId} or an unclaimed 0) — refusing to open it`,
      );
    }

    const currentVersion = readPragmaInt(db, 'user_version');
    if (currentVersion > targetVersion) {
      throw new MigrationError(
        `"${path}" is format version ${currentVersion}, newer than the ` +
          `${targetVersion} this build understands — refusing to open it. ` +
          `Update the application before touching this file.`,
      );
    }

    const pending = options.migrations.filter((m) => m.version > currentVersion);
    if (pending.length > 0) {
      // A file at version 0 has no schema of ours installed yet — nothing
      // worth losing. Anything past that gets a backup before its bytes
      // change (format spec §10).
      if (currentVersion > 0) {
        db.pragma('wal_checkpoint(TRUNCATE)');
        copyFileSync(path, backupPath(path, currentVersion, now()));
      }
      if (storedAppId === 0) {
        db.pragma(`application_id = ${options.applicationId}`);
      }
      for (const migration of pending) {
        db.transaction(() => {
          migration.up(db);
          db.pragma(`user_version = ${migration.version}`);
        })();
      }
    }

    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    const ok = integrity.length === 1 && integrity[0]!.integrity_check === 'ok';
    if (!ok) {
      throw new MigrationError(
        `"${path}" failed integrity_check: ${integrity.map((r) => r.integrity_check).join('; ')}`,
      );
    }

    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** A closed set as SQL: `'a', 'b', 'c'`, for a migration's frozen `CHECK (x IN (...))`. */
export const sqlList = (values: readonly string[]): string =>
  values.map((v) => `'${v}'`).join(', ');

/**
 * Rebuilds `table` from `ddl` inside a migration, keeping every row and
 * id — how a CHECK is widened, since SQLite cannot `ALTER` one
 * (backlog #64). `ddl` creates the table under its own name, with its
 * indexes and triggers.
 *
 * The order is rename-first: rename the old table aside, drop its
 * indexes and triggers, create the new one, copy every column by name,
 * drop the old. The usual create-copy-drop-rename fails on a
 * self-referencing table such as `audit_event` (`batch_id REFERENCES
 * audit_event(id)`) under `foreign_keys = ON`: dropping the original
 * deletes rows the copy's `batch_id`s still point at. Renamed first,
 * the old table's self-reference follows it and the new table's points
 * at itself. Triggers are dropped before the copy and the drop, so an
 * append-only table's own triggers never see either.
 *
 * Refused for a table another table references (`segment`,
 * `translation_order`): the rename would repoint their foreign keys at
 * the old table, and the fix, foreign keys off, has to be set before
 * `BEGIN`, which the runner's per-migration transaction does not allow
 * today. The first migration that needs it extends the runner.
 */
export function rebuildTable(db: Database.Database, table: string, ddl: string): void {
  if (!db.inTransaction) {
    throw new MigrationError(
      `rebuildTable("${table}") runs inside a migration's transaction`,
    );
  }
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    if (name === table) continue;
    const referenced = db
      .prepare('SELECT 1 FROM pragma_foreign_key_list(?) WHERE "table" = ?')
      .get(name, table);
    if (referenced) {
      throw new MigrationError(
        `rebuildTable("${table}"): "${name}" references it, and a rebuild would ` +
          'repoint that foreign key; this needs foreign keys off before BEGIN',
      );
    }
  }

  const columns = (
    db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{
      name: string;
    }>
  ).map((c) => `"${c.name}"`);
  if (columns.length === 0) {
    throw new MigrationError(`rebuildTable("${table}"): no such table`);
  }
  const count = (name: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
  const rows = count(table);

  const old = `${table}__rebuild`;
  db.exec(`ALTER TABLE "${table}" RENAME TO "${old}"`);
  const attached = db
    .prepare(
      `SELECT type, name FROM sqlite_master
       WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL`,
    )
    .all(old) as Array<{ type: 'index' | 'trigger'; name: string }>;
  for (const { type, name } of attached) {
    db.exec(`DROP ${type === 'index' ? 'INDEX' : 'TRIGGER'} "${name}"`);
  }
  db.exec(ddl);
  const list = columns.join(', ');
  db.exec(`INSERT INTO "${table}" (${list}) SELECT ${list} FROM "${old}"`);
  db.exec(`DROP TABLE "${old}"`);

  if (count(table) !== rows) {
    throw new MigrationError(
      `rebuildTable("${table}") lost rows: ${rows} → ${count(table)}`,
    );
  }
  const broken = db.prepare('SELECT 1 FROM pragma_foreign_key_check(?)').get(table);
  if (broken) {
    throw new MigrationError(`rebuildTable("${table}") left a broken foreign key`);
  }
}
