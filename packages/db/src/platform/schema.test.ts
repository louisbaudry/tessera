import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openAndMigrate } from '../migrate.js';
import { verifyAudit } from '../audit/events.js';
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
    expect(db.pragma('user_version', { simple: true })).toBe(8);
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all();
    expect(triggers).toEqual([
      { name: 'audit_event_no_delete' },
      { name: 'audit_event_no_update' },
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
