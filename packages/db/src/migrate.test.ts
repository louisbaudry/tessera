import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { MigrationError, openAndMigrate, type Migration } from './migrate.js';

const APP_ID = 0x54455354; // "TEST"

let dir: string;
const dbPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-db-'));
  return join(dir, 'test.sqlite');
};

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const migrations: Migration[] = [
  {
    version: 1,
    description: 'create widgets',
    up: (db) =>
      db.exec('CREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT NOT NULL)'),
  },
  {
    version: 2,
    description: 'add widget.color',
    up: (db) =>
      db.exec("ALTER TABLE widget ADD COLUMN color TEXT NOT NULL DEFAULT 'grey'"),
  },
];

describe('openAndMigrate', () => {
  it('creates a fresh file, claims it, and runs every migration', () => {
    const path = dbPath();
    const db = openAndMigrate(path, { applicationId: APP_ID, migrations });
    expect(db.pragma('application_id', { simple: true })).toBe(APP_ID);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    db.prepare('INSERT INTO widget (name, color) VALUES (?, ?)').run('cog', 'red');
    expect(db.prepare('SELECT * FROM widget').all()).toEqual([
      { id: 1, name: 'cog', color: 'red' },
    ]);
    db.close();
  });

  it('sets WAL and synchronous=FULL', () => {
    const db = openAndMigrate(dbPath(), { applicationId: APP_ID, migrations });
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(2); // FULL (0=OFF,1=NORMAL,2=FULL)
    db.close();
  });

  it('is idempotent: reopening an up-to-date file re-migrates nothing', () => {
    const path = dbPath();
    openAndMigrate(path, { applicationId: APP_ID, migrations }).close();
    const db = openAndMigrate(path, { applicationId: APP_ID, migrations });
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    db.close();
    // No pending migrations means no backup, on a no-op reopen.
    expect(readdirSync(dir).some((f) => f.includes('.bak-'))).toBe(false);
  });

  it('applies only the migrations a partially-migrated file is missing', () => {
    const path = dbPath();
    openAndMigrate(path, { applicationId: APP_ID, migrations: [migrations[0]!] }).close();
    const db = openAndMigrate(path, { applicationId: APP_ID, migrations });
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(
      db
        .prepare("SELECT name FROM pragma_table_info('widget') WHERE name = 'color'")
        .get(),
    ).toBeDefined();
    db.close();
  });

  it('backs up an existing file before migrating it, not a brand-new one', () => {
    const path = dbPath();
    openAndMigrate(path, { applicationId: APP_ID, migrations: [migrations[0]!] }).close();
    let backedUp: string | null = null;
    const db = openAndMigrate(path, {
      applicationId: APP_ID,
      migrations,
      backupPath: (p, fromVersion) => {
        backedUp = `${p}.backup-${fromVersion}`;
        return backedUp;
      },
    });
    db.close();
    expect(backedUp).not.toBeNull();
    expect(existsSync(backedUp!)).toBe(true);
    // The backup reflects the pre-migration schema (no color column yet).
    const backup = new Database(backedUp!, { readonly: true });
    expect(
      backup
        .prepare("SELECT name FROM pragma_table_info('widget') WHERE name = 'color'")
        .get(),
    ).toBeUndefined();
    backup.close();
  });

  it('never backs up when creating a file for the first time', () => {
    const path = dbPath();
    let called = false;
    openAndMigrate(path, {
      applicationId: APP_ID,
      migrations,
      backupPath: () => {
        called = true;
        return `${path}.unused`;
      },
    }).close();
    expect(called).toBe(false);
  });

  it('refuses a file claimed by a different application_id', () => {
    const path = dbPath();
    openAndMigrate(path, { applicationId: APP_ID, migrations }).close();
    expect(() => openAndMigrate(path, { applicationId: APP_ID + 1, migrations })).toThrow(
      MigrationError,
    );
  });

  it('refuses a file whose format version is newer than this build knows', () => {
    const path = dbPath();
    openAndMigrate(path, { applicationId: APP_ID, migrations }).close();
    expect(() =>
      openAndMigrate(path, { applicationId: APP_ID, migrations: [migrations[0]!] }),
    ).toThrow(MigrationError);
    expect(() =>
      openAndMigrate(path, { applicationId: APP_ID, migrations: [migrations[0]!] }),
    ).toThrow(/newer than/);
  });

  it('surfaces a failed integrity_check rather than swallowing it', () => {
    const path = dbPath();
    openAndMigrate(path, { applicationId: APP_ID, migrations }).close();
    // Corrupt the file by truncating it mid-page.
    const bytes = readFileSync(path);
    writeFileSync(path, bytes.subarray(0, Math.floor(bytes.length / 2)));
    expect(() => openAndMigrate(path, { applicationId: APP_ID, migrations })).toThrow();
  });

  it('rejects a non-contiguous or empty migration list', () => {
    const path = dbPath();
    expect(() => openAndMigrate(path, { applicationId: APP_ID, migrations: [] })).toThrow(
      MigrationError,
    );
    expect(() =>
      openAndMigrate(path, {
        applicationId: APP_ID,
        migrations: [{ ...migrations[0]!, version: 2 }],
      }),
    ).toThrow(MigrationError);
  });

  it('rolls a failed migration back rather than leaving user_version bumped', () => {
    const path = dbPath();
    const broken: Migration[] = [
      migrations[0]!,
      {
        version: 2,
        description: 'deliberately broken',
        up: (db) => db.exec('CREATE TABLE widget (id INTEGER)'), // widget already exists
      },
    ];
    expect(() =>
      openAndMigrate(path, { applicationId: APP_ID, migrations: broken }),
    ).toThrow();
    const db = new Database(path);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    db.close();
  });
});
