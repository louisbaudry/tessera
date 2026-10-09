/**
 * `project_authorization` (backlog #45): the grants, their audit events,
 * and the migration that adds the role to accounts that already exist.
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents, verifyAudit } from '../audit/events.js';
import { openAndMigrate } from '../migrate.js';
import {
  createAccount,
  getAccountByEmail,
  getAccountById,
  type Account,
} from './accounts.js';
import {
  AuthorizationError,
  grantProjectAuthorization,
  listAuthorizationsFor,
  listAuthorizationsOn,
  revokeAllProjectAuthorizations,
  revokeProjectAuthorization,
  scopeOf,
} from './authorization.js';
import { openPlatformDb } from './index.js';
import { PLATFORM_APPLICATION_ID, PLATFORM_MIGRATIONS } from './schema.js';

let dir: string;
let db: Database.Database;
let owner: Account;
let vendor: Account;
let other: Account;

const make = (email: string, role?: 'owner' | 'vendor') =>
  createAccount(db, {
    email,
    passwordHash: 'hash',
    actor: TEST_ACTOR,
    ...(role ? { role } : {}),
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-authorization-'));
  db = openPlatformDb(join(dir, 'platform.sqlite'));
  owner = make('owner@example.com');
  vendor = make('vendor@example.com', 'vendor');
  other = make('other@example.com');
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const ref = (name = 'brief') => ({ accountId: owner.id, name });
const events = (name = 'brief') =>
  listEvents(db, { subjectType: 'project', subjectId: `${owner.id}/${name}` }).filter(
    (e) => e.action.startsWith('authorization.'),
  );

describe('account.role', () => {
  it('is owner unless said otherwise, and is read back', () => {
    expect(owner.role).toBe('owner');
    expect(vendor.role).toBe('vendor');
    expect(getAccountById(db, vendor.id)?.role).toBe('vendor');
    expect(getAccountByEmail(db, 'owner@example.com')?.role).toBe('owner');
    expect(getAccountById(db, 999)).toBeNull();
  });

  it('refuses a role outside the closed set', () => {
    expect(() =>
      db.prepare("UPDATE account SET role = 'admin' WHERE id = ?").run(owner.id),
    ).toThrow(/CHECK/);
  });

  it('is `owner` for the accounts that existed before the migration', () => {
    const path = join(dir, 'old.sqlite');
    const old = openAndMigrate(path, {
      applicationId: PLATFORM_APPLICATION_ID,
      migrations: PLATFORM_MIGRATIONS.slice(0, 3),
    });
    old
      .prepare(
        'INSERT INTO account (email, password_hash, storage_root, created_at) VALUES (?, ?, ?, ?)',
      )
      .run('old@example.com', 'hash', 'u/old', '2026-01-01');
    old.close();

    const migrated = openPlatformDb(path);
    expect(getAccountByEmail(migrated, 'old@example.com')?.role).toBe('owner');
    expect(migrated.pragma('user_version', { simple: true })).toBe(6);
    migrated.close();
    // the migration took a backup first, as every migration does
    expect(
      readdirSync(dir).some((f) => f.startsWith('old.sqlite') && f !== 'old.sqlite'),
    ).toBe(true);
  });
});

describe('grantProjectAuthorization', () => {
  it('gives an account a scope on a project, and nothing on any other', () => {
    grantProjectAuthorization(db, {
      accountId: vendor.id,
      project: ref(),
      scope: 'assigned_translator',
      actor: TEST_ACTOR,
    });
    expect(scopeOf(db, vendor.id, ref())).toBe('assigned_translator');
    expect(scopeOf(db, vendor.id, ref('other-project'))).toBeNull();
    expect(scopeOf(db, other.id, ref())).toBeNull();
    // the same slug under another owner is another project
    expect(scopeOf(db, vendor.id, { accountId: other.id, name: 'brief' })).toBeNull();
  });

  it('records one event naming the project, the grantee and the scope, in the same chain', () => {
    grantProjectAuthorization(db, {
      accountId: vendor.id,
      project: ref(),
      scope: 'assigned_translator',
      actor: TEST_ACTOR,
    });
    const [granted] = events();
    expect(granted).toMatchObject({
      action: 'authorization.granted',
      actor: 'cli:test',
      detail: JSON.stringify({ grantee: vendor.id, scope: 'assigned_translator' }),
    });
    expect(verifyAudit(db).brokenAt).toBeNull();
  });

  it('is idempotent: granting what is held changes and records nothing', () => {
    const grant = () =>
      grantProjectAuthorization(db, {
        accountId: vendor.id,
        project: ref(),
        scope: 'assigned_translator',
        actor: TEST_ACTOR,
      });
    grant();
    grant();
    expect(events()).toHaveLength(1);
    expect(listAuthorizationsOn(db, ref())).toHaveLength(1);
  });

  it('refuses the owner, an unknown account and an unknown scope, recording nothing', () => {
    const base = {
      project: ref(),
      scope: 'assigned_translator' as const,
      actor: TEST_ACTOR,
    };
    expect(() => grantProjectAuthorization(db, { ...base, accountId: owner.id })).toThrow(
      AuthorizationError,
    );
    expect(() => grantProjectAuthorization(db, { ...base, accountId: 999 })).toThrow(
      /no account #999/,
    );
    expect(() =>
      grantProjectAuthorization(db, {
        ...base,
        accountId: vendor.id,
        project: { accountId: 999, name: 'brief' },
      }),
    ).toThrow(/no account #999/);
    expect(() =>
      grantProjectAuthorization(db, {
        ...base,
        accountId: vendor.id,
        scope: 'owner' as never,
      }),
    ).toThrow(/unknown scope/);
    expect(events()).toEqual([]);
  });

  it('cannot be written around: the table itself refuses a self-grant and a bad scope', () => {
    const insert = (accountId: number, scope: string) =>
      db
        .prepare(
          `INSERT INTO project_authorization
             (account_id, owner_id, project_name, scope, granted_at)
           VALUES (?, ?, 'brief', ?, 'now')`,
        )
        .run(accountId, owner.id, scope);
    expect(() => insert(owner.id, 'assigned_translator')).toThrow(/CHECK/);
    expect(() => insert(vendor.id, 'reviewer')).toThrow(/CHECK/);
  });
});

describe('revoking', () => {
  const grant = (account: Account, name = 'brief') =>
    grantProjectAuthorization(db, {
      accountId: account.id,
      project: ref(name),
      scope: 'assigned_translator',
      actor: TEST_ACTOR,
    });

  it('takes the scope away and says so, once', () => {
    grant(vendor);
    expect(
      revokeProjectAuthorization(db, {
        accountId: vendor.id,
        project: ref(),
        actor: TEST_ACTOR,
      }),
    ).toBe(true);
    expect(scopeOf(db, vendor.id, ref())).toBeNull();
    expect(events().map((e) => e.action)).toEqual([
      'authorization.granted',
      'authorization.revoked',
    ]);
  });

  it('records nothing for a grant that was never there', () => {
    expect(
      revokeProjectAuthorization(db, {
        accountId: vendor.id,
        project: ref(),
        actor: TEST_ACTOR,
      }),
    ).toBe(false);
    expect(events()).toEqual([]);
  });

  it('removes every grant on a project and no other, one event each', () => {
    grant(vendor);
    grant(other);
    grant(vendor, 'second');
    expect(
      revokeAllProjectAuthorizations(db, { project: ref(), actor: TEST_ACTOR }),
    ).toBe(2);
    expect(listAuthorizationsOn(db, ref())).toEqual([]);
    expect(scopeOf(db, vendor.id, ref('second'))).toBe('assigned_translator');
    expect(events().filter((e) => e.action === 'authorization.revoked')).toHaveLength(2);
    expect(verifyAudit(db).brokenAt).toBeNull();
  });

  it('lists what an account was granted, oldest first', () => {
    grant(vendor, 'one');
    grant(vendor, 'two');
    expect(listAuthorizationsFor(db, vendor.id).map((a) => a.project.name)).toEqual([
      'one',
      'two',
    ]);
    expect(listAuthorizationsFor(db, other.id)).toEqual([]);
  });
});
