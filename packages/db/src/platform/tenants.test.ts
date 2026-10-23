import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashPassword } from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { createAccount } from './accounts.js';
import { createTenant } from './create-tenant.js';
import { openPlatformDb } from './index.js';
import {
  getTenantById,
  getTenantForAccount,
  listTenants,
  renameTenant,
  TenantError,
} from './tenants.js';

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-tenants-'));
  db = openPlatformDb(join(dir, 'platform.sqlite'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const hash = hashPassword('x');
interface Event {
  action: string;
  actor: string;
  subjectType: string;
  subjectId: string | null;
  detail: string | null;
}
const events = (): Event[] =>
  db
    .prepare(
      `SELECT action, actor, subject_type AS subjectType, subject_id AS subjectId, detail
       FROM audit_event ORDER BY id`,
    )
    .all() as Event[];
const actions = () => events().map((e) => e.action);

describe('createTenant', () => {
  it('makes a tenant whose first admin is a new owner account, in one write', () => {
    const { tenant, account } = createTenant(db, {
      name: 'Example Language Services',
      email: 'admin@example.com',
      passwordHash: hash,
      actor: TEST_ACTOR,
    });
    expect(tenant.name).toBe('Example Language Services');
    expect(account.role).toBe('owner');
    expect(getTenantForAccount(db, account.id)).toEqual({ tenant, role: 'admin' });
    expect(getTenantById(db, tenant.id)).toEqual(tenant);
  });

  it("takes its founding admin's minted storage root, never one a caller chose", () => {
    const { tenant, account } = createTenant(db, {
      name: 'Acme',
      email: 'a@example.com',
      passwordHash: hash,
      actor: TEST_ACTOR,
    });
    // Until the readers move to the tenant (slice 2) every file is still under the
    // account's root, so the tenant must name exactly that directory.
    expect(tenant.storageRoot).toBe(account.storageRoot);
    expect(tenant.storageRoot).toMatch(/^u\/[0-9a-f]{24}$/);
  });

  it('logs account.created then tenant.created, naming the actor', () => {
    const { tenant } = createTenant(db, {
      name: 'Acme',
      email: 'a@example.com',
      passwordHash: hash,
      actor: TEST_ACTOR,
    });
    const log = events();
    expect(log.map((e) => e.action)).toEqual(['account.created', 'tenant.created']);
    expect(log[1]).toMatchObject({
      subjectType: 'tenant',
      subjectId: String(tenant.id),
      detail: null,
    });
    expect(log[1]!.actor).toBe(log[0]!.actor);
  });

  it('writes nothing when the admin cannot be created', () => {
    createAccount(db, {
      email: 'taken@example.com',
      passwordHash: hash,
      actor: TEST_ACTOR,
    });
    const before = actions().length;
    expect(() =>
      createTenant(db, {
        name: 'Acme',
        email: 'taken@example.com',
        passwordHash: hash,
        actor: TEST_ACTOR,
      }),
    ).toThrow();
    // the pre-existing owner's own tenant is the only one; no half-made second one
    expect(listTenants(db)).toHaveLength(1);
    expect(actions()).toHaveLength(before);
  });

  it.each(['', '   ', 'a'.repeat(121), 'two\nlines', 'bell\u0007'])(
    'refuses the name %j',
    (name) => {
      expect(() =>
        createTenant(db, {
          name,
          email: 'a@example.com',
          passwordHash: hash,
          actor: TEST_ACTOR,
        }),
      ).toThrow(TenantError);
      expect(listTenants(db)).toHaveLength(0);
    },
  );

  it('trims the name', () => {
    const { tenant } = createTenant(db, {
      name: '  Acme  ',
      email: 'a@example.com',
      passwordHash: hash,
      actor: TEST_ACTOR,
    });
    expect(tenant.name).toBe('Acme');
  });
});

describe('createAccount', () => {
  it('gives every new owner a tenant of its own, so no owner is ever without one', () => {
    const owner = createAccount(db, {
      email: 'o@example.com',
      passwordHash: hash,
      actor: TEST_ACTOR,
    });
    const found = getTenantForAccount(db, owner.id);
    expect(found?.role).toBe('admin');
    expect(found?.tenant.storageRoot).toBe(owner.storageRoot);
    expect(found?.tenant.name).toBe(`Tenant ${found?.tenant.id}`);
    expect(actions()).toEqual(['account.created', 'tenant.created']);
  });

  it('gives a vendor none: a vendor is never tenant staff (spec D3)', () => {
    const vendor = createAccount(db, {
      email: 'v@example.com',
      passwordHash: hash,
      role: 'vendor',
      actor: TEST_ACTOR,
    });
    expect(getTenantForAccount(db, vendor.id)).toBeNull();
    expect(listTenants(db)).toEqual([]);
    expect(actions()).toEqual(['account.created']);
  });
});

describe('tenant_membership', () => {
  const owner = () =>
    createAccount(db, { email: 'o@example.com', passwordHash: hash, actor: TEST_ACTOR });

  it('refuses to make a vendor staff, in the schema and not in a route', () => {
    const o = owner();
    const vendor = createAccount(db, {
      email: 'v@example.com',
      passwordHash: hash,
      role: 'vendor',
      actor: TEST_ACTOR,
    });
    const tenant = getTenantForAccount(db, o.id)!.tenant;
    expect(() =>
      db
        .prepare(
          "INSERT INTO tenant_membership (tenant_id, account_id, role, added_at) VALUES (?, ?, 'pm', '2026-01-01')",
        )
        .run(tenant.id, vendor.id),
    ).toThrow(/vendor is never tenant staff/);
  });

  it('keeps one tenant per person in v1 (spec D2, O1)', () => {
    const o = owner();
    const second = createTenant(db, {
      name: 'Other',
      email: 'other@example.com',
      passwordHash: hash,
      actor: TEST_ACTOR,
    });
    expect(() =>
      db
        .prepare(
          "INSERT INTO tenant_membership (tenant_id, account_id, role, added_at) VALUES (?, ?, 'pm', '2026-01-01')",
        )
        .run(second.tenant.id, o.id),
    ).toThrow(/UNIQUE/);
  });

  it('refuses a role outside the closed set', () => {
    const o = owner();
    expect(() =>
      db
        .prepare("UPDATE tenant_membership SET role = 'owner' WHERE account_id = ?")
        .run(o.id),
    ).toThrow(/CHECK/);
  });

  it('gives each tenant its own storage root', () => {
    const a = createTenant(db, {
      name: 'A',
      email: 'a@example.com',
      passwordHash: hash,
      actor: TEST_ACTOR,
    });
    const b = createTenant(db, {
      name: 'B',
      email: 'b@example.com',
      passwordHash: hash,
      actor: TEST_ACTOR,
    });
    expect(a.tenant.storageRoot).not.toBe(b.tenant.storageRoot);
    expect(() =>
      db
        .prepare('UPDATE tenant SET storage_root = ? WHERE id = ?')
        .run(a.tenant.storageRoot, b.tenant.id),
    ).toThrow(/UNIQUE/);
  });
});

describe('renameTenant', () => {
  it('changes only the display name and logs tenant.renamed with no name in it', () => {
    const { tenant } = createTenant(db, {
      name: 'Before',
      email: 'a@example.com',
      passwordHash: hash,
      actor: TEST_ACTOR,
    });
    const renamed = renameTenant(db, {
      tenantId: tenant.id,
      name: ' After ',
      actor: TEST_ACTOR,
    });
    expect(renamed).toEqual({ ...tenant, name: 'After' });
    expect(getTenantById(db, tenant.id)).toEqual(renamed);
    const last = events().at(-1)!;
    // a name is a company's, and a detail is hashed so erasure could never reach it
    expect(last).toMatchObject({
      action: 'tenant.renamed',
      subjectType: 'tenant',
      subjectId: String(tenant.id),
      detail: null,
    });
  });

  it('logs nothing when the name is unchanged', () => {
    const { tenant } = createTenant(db, {
      name: 'Same',
      email: 'a@example.com',
      passwordHash: hash,
      actor: TEST_ACTOR,
    });
    const before = actions().length;
    renameTenant(db, { tenantId: tenant.id, name: 'Same', actor: TEST_ACTOR });
    expect(actions()).toHaveLength(before);
  });

  it('refuses an unknown tenant and a bad name, writing nothing', () => {
    const { tenant } = createTenant(db, {
      name: 'Acme',
      email: 'a@example.com',
      passwordHash: hash,
      actor: TEST_ACTOR,
    });
    const before = actions().length;
    expect(() =>
      renameTenant(db, { tenantId: 999, name: 'X', actor: TEST_ACTOR }),
    ).toThrow(TenantError);
    expect(() =>
      renameTenant(db, { tenantId: tenant.id, name: '  ', actor: TEST_ACTOR }),
    ).toThrow(TenantError);
    expect(getTenantById(db, tenant.id)?.name).toBe('Acme');
    expect(actions()).toHaveLength(before);
  });
});

describe('reading tenants', () => {
  it('lists them in creation order and finds none for a stranger', () => {
    const a = createTenant(db, {
      name: 'A',
      email: 'a@example.com',
      passwordHash: hash,
      actor: TEST_ACTOR,
    });
    const b = createTenant(db, {
      name: 'B',
      email: 'b@example.com',
      passwordHash: hash,
      actor: TEST_ACTOR,
    });
    expect(listTenants(db)).toEqual([a.tenant, b.tenant]);
    expect(getTenantById(db, 999)).toBeNull();
    expect(getTenantForAccount(db, 999)).toBeNull();
  });
});
