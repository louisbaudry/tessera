import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openAndMigrate } from '../migrate.js';
import { verifyAudit } from '../audit/events.js';
import type Database from 'better-sqlite3';
import { openPlatformDb } from './index.js';
import { PLATFORM_APPLICATION_ID, PLATFORM_MIGRATIONS } from './schema.js';
import { PROJECT_APPLICATION_ID } from '../project/schema.js';

let dir: string;
const dbPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-platform-'));
  return join(dir, 'platform.sqlite');
};

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('openPlatformDb', () => {
  it('is a distinct file type from the project database', () => {
    expect(PLATFORM_APPLICATION_ID).not.toBe(PROJECT_APPLICATION_ID);
    const db = openPlatformDb(dbPath());
    expect(db.pragma('application_id', { simple: true })).toBe(PLATFORM_APPLICATION_ID);
    db.close();
  });

  it('enforces one account per email and one storage root per account', () => {
    const db = openPlatformDb(dbPath());
    const insert = db.prepare(
      'INSERT INTO account (email, password_hash, storage_root, created_at) VALUES (?, ?, ?, ?)',
    );
    insert.run('me@example.com', 'hash', 'u/1', '2026-01-01');
    expect(() => insert.run('me@example.com', 'hash2', 'u/2', '2026-01-01')).toThrow();
    expect(() => insert.run('other@example.com', 'hash', 'u/1', '2026-01-01')).toThrow();
    db.close();
  });

  it('carries the shared, append-only audit_event from v3 (backlog #57)', () => {
    const db = openPlatformDb(dbPath());
    expect(db.pragma('user_version', { simple: true })).toBe(13);
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all();
    expect(triggers).toEqual([
      { name: 'audit_event_no_delete' },
      { name: 'audit_event_no_update' },
      { name: 'project_authorization_not_staff' },
      { name: 'roster_membership_not_staff' },
      { name: 'staff_invitation_final' },
      { name: 'tenant_membership_keep_admin_delete' },
      { name: 'tenant_membership_keep_admin_update' },
      { name: 'tenant_membership_staff_only' },
      { name: 'vendor_invitation_final' },
    ]);
    db.close();
  });
});

describe('the tenant migration (planning/tenant-spec.md §5, backlog #204)', () => {
  const insert =
    'INSERT INTO account (email, password_hash, storage_root, role, created_at) VALUES (?, ?, ?, ?, ?)';

  it('makes each existing owner the admin of a tenant that takes over its storage root', () => {
    const path = dbPath();
    const old = openAndMigrate(path, {
      applicationId: PLATFORM_APPLICATION_ID,
      migrations: PLATFORM_MIGRATIONS.slice(0, 7),
    });
    old.prepare(insert).run('a@example.com', 'h', 'u/aaa', 'owner', '2026-01-01');
    old.prepare(insert).run('v@example.com', 'h', 'u/vvv', 'vendor', '2026-01-02');
    old.prepare(insert).run('b@example.com', 'h', 'u/bbb', 'owner', '2026-01-03');
    old.close();

    const db = openPlatformDb(path);
    const tenants = db
      .prepare('SELECT id, name, storage_root, created_at FROM tenant ORDER BY id')
      .all();
    // no file moves: the tenant names the directory the owner already had
    expect(tenants).toEqual([
      { id: 1, name: 'Tenant 1', storage_root: 'u/aaa', created_at: '2026-01-01' },
      { id: 2, name: 'Tenant 2', storage_root: 'u/bbb', created_at: '2026-01-03' },
    ]);
    const members = db
      .prepare(
        `SELECT a.email, m.tenant_id, m.role FROM tenant_membership m
         JOIN account a ON a.id = m.account_id ORDER BY m.tenant_id`,
      )
      .all();
    expect(members).toEqual([
      { email: 'a@example.com', tenant_id: 1, role: 'admin' },
      { email: 'b@example.com', tenant_id: 2, role: 'admin' },
    ]);
    // the vendor is on no tenant, and no real name was written by a migration
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM tenant WHERE name NOT LIKE 'Tenant %'").get(),
    ).toEqual({ n: 0 });
    db.close();
  });

  it('writes no audit event and invents no author, and keeps the log verifiable', () => {
    const path = dbPath();
    const old = openAndMigrate(path, {
      applicationId: PLATFORM_APPLICATION_ID,
      migrations: PLATFORM_MIGRATIONS.slice(0, 7),
    });
    old.prepare(insert).run('a@example.com', 'h', 'u/aaa', 'owner', '2026-01-01');
    old.close();
    const db = openPlatformDb(path);
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_event').get()).toEqual({ n: 0 });
    expect(verifyAudit(db)).toEqual({ events: 0, brokenAt: null });
    db.close();
  });

  it('migrates a file with no accounts to empty tenant tables', () => {
    const db = openPlatformDb(dbPath());
    expect(db.prepare('SELECT COUNT(*) AS n FROM tenant').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tenant_membership').get()).toEqual({
      n: 0,
    });
    db.close();
  });
});

describe('the re-key migration (planning/tenant-spec.md §4, backlog #205)', () => {
  const account =
    'INSERT INTO account (email, password_hash, storage_root, role, created_at) VALUES (?, ?, ?, ?, ?)';

  /** A v8 file: owners 1 and 3 (tenants 1 and 2), vendor 2, rows of every re-keyed table. */
  function v8File(path: string, extra?: (db: Database.Database) => void): void {
    const db = openAndMigrate(path, {
      applicationId: PLATFORM_APPLICATION_ID,
      migrations: PLATFORM_MIGRATIONS.slice(0, 8),
    });
    db.prepare(account).run('a@example.com', 'h', 'u/aaa', 'owner', '2026-01-01');
    db.prepare(account).run('v@example.com', 'h', 'u/vvv', 'vendor', '2026-01-02');
    db.prepare(account).run('b@example.com', 'h', 'u/bbb', 'owner', '2026-01-03');
    const tenant = db.prepare(
      'INSERT INTO tenant (name, storage_root, created_at) VALUES (?, ?, ?)',
    );
    tenant.run('Tenant 1', 'u/aaa', '2026-01-01');
    tenant.run('Tenant 2', 'u/bbb', '2026-01-03');
    const member = db.prepare(
      "INSERT INTO tenant_membership (tenant_id, account_id, role, added_at) VALUES (?, ?, 'admin', '2026-01-01')",
    );
    member.run(1, 1);
    member.run(2, 3);
    db.prepare(
      `INSERT INTO project_authorization (account_id, owner_id, project_name, scope, granted_at)
       VALUES (2, 3, 'job', 'assigned_translator', '2026-02-01')`,
    ).run();
    db.prepare(
      "INSERT INTO roster_membership (owner_id, account_id, added_at) VALUES (3, 2, '2026-02-01')",
    ).run();
    db.prepare(
      `INSERT INTO vendor_invitation (owner_id, email, token_hash, created_at, expires_at)
       VALUES (3, 'new@example.com', 'hash', '2026-02-01', '2026-03-01')`,
    ).run();
    db.prepare(
      "INSERT INTO client_engine_consent (owner_id, client_id, engine, consented_at) VALUES (3, 7, 'deepl', '2026-02-01')",
    ).run();
    db.prepare(
      "INSERT INTO client_engine_default (owner_id, client_id, engine) VALUES (3, 7, 'deepl')",
    ).run();
    extra?.(db);
    db.close();
  }

  it('names the tenant, not the owner account, in all five tables', () => {
    const path = dbPath();
    v8File(path);
    const db = openPlatformDb(path);
    // owner 3 is tenant 2: the ids differ on purpose, so a column that kept the account id fails here
    expect(
      db
        .prepare('SELECT account_id, tenant_id, project_name FROM project_authorization')
        .all(),
    ).toEqual([{ account_id: 2, tenant_id: 2, project_name: 'job' }]);
    expect(
      db.prepare('SELECT tenant_id, account_id FROM roster_membership').all(),
    ).toEqual([{ tenant_id: 2, account_id: 2 }]);
    expect(db.prepare('SELECT tenant_id, email FROM vendor_invitation').all()).toEqual([
      { tenant_id: 2, email: 'new@example.com' },
    ]);
    expect(
      db.prepare('SELECT tenant_id, client_id, engine FROM client_engine_consent').all(),
    ).toEqual([{ tenant_id: 2, client_id: 7, engine: 'deepl' }]);
    expect(
      db.prepare('SELECT tenant_id, client_id, engine FROM client_engine_default').all(),
    ).toEqual([{ tenant_id: 2, client_id: 7, engine: 'deepl' }]);
    for (const table of [
      'project_authorization',
      'roster_membership',
      'vendor_invitation',
      'client_engine_consent',
      'client_engine_default',
    ]) {
      const columns = db
        .prepare(`SELECT name FROM pragma_table_info('${table}')`)
        .all() as Array<{ name: string }>;
      expect(
        columns.map((c) => c.name),
        table,
      ).not.toContain('owner_id');
      expect(
        db
          .prepare(
            `SELECT 1 FROM pragma_foreign_key_list('${table}') WHERE "table" = 'tenant'`,
          )
          .get(),
        table,
      ).toBeTruthy();
    }
    db.close();
  });

  it('keeps the invitation trigger and the indexes the old tables had', () => {
    const path = dbPath();
    v8File(path);
    const db = openPlatformDb(path);
    expect(() =>
      db.prepare("UPDATE vendor_invitation SET revoked_at = '2026-02-02'").run(),
    ).not.toThrow();
    expect(() =>
      db.prepare("UPDATE vendor_invitation SET expires_at = '2027-01-01'").run(),
    ).toThrow(/final/);
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    expect(indexes).toEqual(
      expect.arrayContaining([
        { name: 'project_authorization_project' },
        { name: 'roster_membership_account' },
        { name: 'vendor_invitation_email' },
        { name: 'vendor_invitation_tenant' },
      ]),
    );
    db.close();
  });

  it('refuses, and discards nothing, when a row names an owner that has no tenant', () => {
    const path = dbPath();
    // grants on a vendor's own "project": nothing could have made a tenant for it
    v8File(path, (db) =>
      db
        .prepare(
          `INSERT INTO project_authorization (account_id, owner_id, project_name, scope, granted_at)
           VALUES (3, 2, 'stray', 'assigned_translator', '2026-02-01')`,
        )
        .run(),
    );
    expect(() => openPlatformDb(path)).toThrow(/no tenant/);
    // the migration ran in one transaction: the file is still v8, rows intact
    const db = openAndMigrate(path, {
      applicationId: PLATFORM_APPLICATION_ID,
      migrations: PLATFORM_MIGRATIONS.slice(0, 8),
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_authorization').get()).toEqual({
      n: 2,
    });
    db.close();
  });
});
