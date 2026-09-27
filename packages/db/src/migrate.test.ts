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

import { TEST_ACTOR } from './audit/actor.fixture.js';
import { appendAuditEvent, auditEventDdl, verifyAudit } from './audit/events.js';
import {
  MigrationError,
  openAndMigrate,
  rebuildTable,
  type Migration,
} from './migrate.js';

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

describe('rebuildTable', () => {
  const auditV1: Migration = {
    version: 1,
    description: 'audit_event, logins only',
    up: (db) => db.exec(auditEventDdl(['auth.login'])),
  };
  const auditV2: Migration = {
    version: 2,
    description: 'audit_event widened to downloads',
    up: (db) =>
      rebuildTable(db, 'audit_event', auditEventDdl(['auth.login', 'file.downloaded'])),
  };

  it('widens a self-referencing CHECK, keeping every row, id, batch and the chain', () => {
    const path = dbPath();
    const before = openAndMigrate(path, { applicationId: APP_ID, migrations: [auditV1] });
    const login = (batchId: number | null) =>
      appendAuditEvent(before, {
        actor: TEST_ACTOR,
        action: 'auth.login',
        subjectType: 'admin_user',
        subjectId: '1',
        batchId,
        detail: null,
      });
    const parent = login(null);
    login(parent.id);
    login(parent.id);
    const rows = before.prepare('SELECT * FROM audit_event ORDER BY id').all();
    expect(() =>
      before
        .prepare(
          "INSERT INTO audit_event (at, actor, action, subject_type, chain_hash) VALUES ('t', 'a', 'file.downloaded', 's', 'h')",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    before.close();

    const after = openAndMigrate(path, {
      applicationId: APP_ID,
      migrations: [auditV1, auditV2],
    });
    expect(after.prepare('SELECT * FROM audit_event ORDER BY id').all()).toEqual(rows);
    expect(verifyAudit(after)).toEqual({ events: 3, brokenAt: null });
    appendAuditEvent(after, {
      actor: TEST_ACTOR,
      action: 'file.downloaded',
      subjectType: 'source_file',
      subjectId: '1',
      batchId: parent.id,
      detail: { file_id: 1, name: 'a.docx', sha256: '00' },
    });
    expect(verifyAudit(after).brokenAt).toBeNull();
    // The append-only triggers came back with the table.
    expect(() => after.prepare('DELETE FROM audit_event').run()).toThrow(/append-only/);
    // Nothing of the old table is left behind, and the batch index is back.
    const schema = after
      .prepare('SELECT type, name FROM sqlite_master ORDER BY type, name')
      .all();
    expect(schema).toEqual([
      { type: 'index', name: 'audit_event_batch' },
      { type: 'index', name: 'audit_event_subject' },
      { type: 'table', name: 'audit_event' },
      { type: 'trigger', name: 'audit_event_no_delete' },
      { type: 'trigger', name: 'audit_event_no_update' },
    ]);
    after.close();
  });

  it('refuses a table another table references, and leaves the file untouched', () => {
    const path = dbPath();
    const v1: Migration = {
      version: 1,
      description: 'parent and child',
      up: (db) =>
        db.exec(`
          CREATE TABLE parent (id INTEGER PRIMARY KEY);
          CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
        `),
    };
    const v2: Migration = {
      version: 2,
      description: 'rebuild parent',
      up: (db) =>
        rebuildTable(
          db,
          'parent',
          'CREATE TABLE parent (id INTEGER PRIMARY KEY, x TEXT);',
        ),
    };
    openAndMigrate(path, { applicationId: APP_ID, migrations: [v1] }).close();
    expect(() =>
      openAndMigrate(path, { applicationId: APP_ID, migrations: [v1, v2] }),
    ).toThrow(/"child" references it/);
    const db = new Database(path);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    db.close();
  });

  it('refuses to run outside a transaction', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    expect(() =>
      rebuildTable(db, 't', 'CREATE TABLE t (id INTEGER PRIMARY KEY);'),
    ).toThrow(MigrationError);
    db.close();
  });
});
