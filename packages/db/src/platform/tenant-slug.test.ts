/**
 * A tenant's slug (backlog #209, `planning/tenant-spec.md` D14): the public name its address is
 * built from. Set once by the operator, unique, a valid label, never a name the platform keeps.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashPassword } from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { verifyAudit } from '../audit/events.js';
import { openAndMigrate } from '../migrate.js';
import { createTenant } from './create-tenant.js';
import { openPlatformDb } from './index.js';
import { PLATFORM_APPLICATION_ID, PLATFORM_MIGRATIONS } from './schema.js';
import {
  getTenantBySlug,
  getTenantForAccount,
  listTenants,
  setTenantSlug,
  TenantError,
  type Tenant,
} from './tenants.js';

let dir: string;
let db: Database.Database;
let a: Tenant;
let b: Tenant;
const hash = hashPassword('x');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-slug-'));
  db = openPlatformDb(join(dir, 'platform.sqlite'));
  a = createTenant(db, {
    name: 'A',
    email: 'a@example.com',
    passwordHash: hash,
    actor: TEST_ACTOR,
  }).tenant;
  b = createTenant(db, {
    name: 'B',
    email: 'b@example.com',
    passwordHash: hash,
    actor: TEST_ACTOR,
  }).tenant;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const slugEvents = () =>
  db
    .prepare(
      "SELECT subject_id AS subjectId, detail, tenant_id AS tenantId FROM audit_event WHERE action = 'tenant.slug_set'",
    )
    .all() as Array<{
    subjectId: string;
    detail: string | null;
    tenantId: number | null;
  }>;

describe('a tenant has no slug until the operator sets one', () => {
  it('reads as null on a new tenant, in every read of a tenant', () => {
    expect(a.slug).toBeNull();
    expect(listTenants(db).map((t) => t.slug)).toEqual([null, null]);
    expect(getTenantForAccount(db, 2)?.tenant.slug).toBeNull();
  });
});

describe('setTenantSlug', () => {
  it('sets it, finds the tenant by it, and logs it about that tenant with no slug in the log', () => {
    const set = setTenantSlug(db, {
      tenantId: a.id,
      slug: 'north-star',
      actor: TEST_ACTOR,
    });
    expect(set.slug).toBe('north-star');
    expect(getTenantBySlug(db, 'north-star')?.id).toBe(a.id);
    expect(getTenantBySlug(db, 'nobody')).toBeNull();
    expect(listTenants(db).map((t) => t.slug)).toEqual(['north-star', null]);
    // a slug derives from a company's name, so like the name it is data and never in the hashed log
    expect(slugEvents()).toEqual([
      { subjectId: String(a.id), detail: null, tenantId: a.id },
    ]);
    expect(verifyAudit(db).brokenAt).toBeNull();
  });

  it('is idempotent for the same slug, and refuses to change one once set', () => {
    setTenantSlug(db, { tenantId: a.id, slug: 'north-star', actor: TEST_ACTOR });
    setTenantSlug(db, { tenantId: a.id, slug: 'north-star', actor: TEST_ACTOR });
    expect(slugEvents()).toHaveLength(1);
    expect(() =>
      setTenantSlug(db, { tenantId: a.id, slug: 'south-star', actor: TEST_ACTOR }),
    ).toThrow(/not changed/);
    expect(getTenantBySlug(db, 'north-star')?.id).toBe(a.id);
  });

  it('refuses a slug another tenant holds, and writes nothing', () => {
    setTenantSlug(db, { tenantId: a.id, slug: 'acme', actor: TEST_ACTOR });
    expect(() =>
      setTenantSlug(db, { tenantId: b.id, slug: 'acme', actor: TEST_ACTOR }),
    ).toThrow(/taken/);
    expect(getTenantBySlug(db, 'acme')?.id).toBe(a.id);
    expect(slugEvents()).toHaveLength(1);
  });

  it('refuses what is not a label, a name the platform keeps, and a tenant that does not exist', () => {
    for (const bad of ['Acme', 'a.b', '-a', '', 'x'.repeat(41)]) {
      expect(
        () => setTenantSlug(db, { tenantId: a.id, slug: bad, actor: TEST_ACTOR }),
        bad,
      ).toThrow(TenantError);
    }
    expect(() =>
      setTenantSlug(db, { tenantId: a.id, slug: 'www', actor: TEST_ACTOR }),
    ).toThrow(/kept for the platform/);
    expect(() =>
      setTenantSlug(db, { tenantId: 999, slug: 'ghost', actor: TEST_ACTOR }),
    ).toThrow(/no tenant/);
    expect(slugEvents()).toEqual([]);
  });

  it('is backed by the schema, not only the repository: a raw write of a bad or duplicate slug fails', () => {
    const write = (slug: string, id: number) =>
      db.prepare('UPDATE tenant SET slug = ? WHERE id = ?').run(slug, id);
    expect(() => write('Bad', a.id)).toThrow(/CHECK/);
    expect(() => write('a.b', a.id)).toThrow(/CHECK/);
    write('shared', a.id);
    expect(() => write('shared', b.id)).toThrow(/UNIQUE/);
  });
});

describe('the migration that adds it', () => {
  it('adds the column to a v12 file with its tenants and a verifying log, leaving every slug null', () => {
    const path = join(dir, 'old.sqlite');
    const old = openAndMigrate(path, {
      applicationId: PLATFORM_APPLICATION_ID,
      migrations: PLATFORM_MIGRATIONS.slice(0, 12),
    });
    // a tenant as the v12 shape holds it: written by hand, since today's code reads the column that is not there yet
    old
      .prepare(
        "INSERT INTO account (email, password_hash, storage_root, role, created_at) VALUES ('o@example.com', 'h', 'u/o', 'owner', '2026-01-01')",
      )
      .run();
    old
      .prepare(
        "INSERT INTO tenant (name, storage_root, created_at) VALUES ('Old', 'u/o', '2026-01-01')",
      )
      .run();
    old
      .prepare(
        "INSERT INTO tenant_membership (tenant_id, account_id, role, added_at) VALUES (1, 1, 'admin', '2026-01-01')",
      )
      .run();
    old.close();
    const migrated = openPlatformDb(path);
    expect(migrated.pragma('user_version', { simple: true })).toBe(
      PLATFORM_MIGRATIONS.length,
    );
    expect(listTenants(migrated).map((t) => t.slug)).toEqual([null]);
    expect(verifyAudit(migrated).brokenAt).toBeNull();
    setTenantSlug(migrated, { tenantId: 1, slug: 'first', actor: TEST_ACTOR });
    expect(verifyAudit(migrated).brokenAt).toBeNull();
    migrated.close();
  });
});
