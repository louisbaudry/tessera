/**
 * A tenant's slice of the platform log (backlog #211, `planning/audit-spec.md` §3.1,
 * `tenant-spec.md` §9 O3): `audit_event.tenant_id` is hashed when set, every platform
 * write names a tenant or says it is about none, and a tenant reads only its own.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateSessionToken, hashPassword, type AuditActor } from '@cat-tool/core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { appendAuditEvent, auditEventDdl, verifyAudit } from '../audit/events.js';
import { openAndMigrate } from '../migrate.js';
import {
  createAccount,
  createAccountSession,
  deleteAccountSession,
  type Account,
} from './accounts.js';
import {
  exportTenantAudit,
  listTenantEvents,
  recordDownload,
  recordFailedLogin,
  recordProjectChange,
} from './audit.js';
import { appendPlatformEvent } from './audit-write.js';
import { grantProjectAuthorization } from './authorization.js';
import { setClientEngineConsent } from './client-engine.js';
import { createTenant } from './create-tenant.js';
import { openPlatformDb } from './index.js';
import { acceptInvitation, createInvitation, revokeInvitation } from './invitations.js';
import { PLATFORM_APPLICATION_ID, PLATFORM_MIGRATIONS } from './schema.js';
import { acceptStaffInvitation, createStaffInvitation } from './staff-invitations.js';
import {
  changeTenantRole,
  removeTenantStaff,
  renameTenant,
  type Tenant,
} from './tenants.js';

let dir: string;
let db: InstanceType<typeof Database>;
let vendor: Account;
let alice: Account;
let carol: Account;
let tenantA: Tenant;
let tenantB: Tenant;

const hash = hashPassword('x');
const self = (a: Account): AuditActor => ({
  actor: { kind: 'account', id: a.id },
  label: a.email,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-tenant-audit-'));
  db = openPlatformDb(join(dir, 'platform.sqlite'));
  // a vendor first, so no tenant id equals its founder's account id
  vendor = createAccount(db, {
    email: 'v@example.com',
    passwordHash: hash,
    role: 'vendor',
    actor: TEST_ACTOR,
  });
  const a = createTenant(db, {
    name: 'A',
    email: 'alice@example.com',
    passwordHash: hash,
    actor: TEST_ACTOR,
  });
  const b = createTenant(db, {
    name: 'B',
    email: 'carol@example.com',
    passwordHash: hash,
    actor: TEST_ACTOR,
  });
  alice = a.account;
  tenantA = a.tenant;
  carol = b.account;
  tenantB = b.tenant;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** Every platform event with the tenant it was stamped with, oldest first. */
const stamped = () =>
  db
    .prepare(
      'SELECT id, action, subject_type AS subjectType, subject_id AS subjectId, tenant_id AS tenantId FROM audit_event ORDER BY id',
    )
    .all() as Array<{
    id: number;
    action: string;
    subjectType: string;
    subjectId: string | null;
    tenantId: number | null;
  }>;
const tenantOfEvents = (action: string) =>
  stamped()
    .filter((e) => e.action === action)
    .map((e) => e.tenantId);

describe('which tenant each platform event is about', () => {
  it('stamps a founded tenant and its first admin, and a vendor made by the operator with none', () => {
    expect(stamped().map((e) => [e.action, e.tenantId])).toEqual([
      ['account.created', null], // the operator's vendor
      ['tenant.created', tenantA.id],
      ['account.created', tenantA.id],
      ['tenant.created', tenantB.id],
      ['account.created', tenantB.id],
    ]);
  });

  it('stamps staff joining, a role change, a removal and a rename with the tenant they are about', () => {
    const { token } = createStaffInvitation(db, {
      tenantId: tenantA.id,
      invitedBy: alice.id,
      email: 'pat@example.com',
      role: 'pm',
      actor: self(alice),
    });
    const { account: pat } = acceptStaffInvitation(db, { token, passwordHash: hash });
    changeTenantRole(db, {
      tenantId: tenantA.id,
      accountId: pat.id,
      role: 'admin',
      actor: self(alice),
    });
    removeTenantStaff(db, {
      tenantId: tenantA.id,
      accountId: pat.id,
      actor: self(alice),
    });
    renameTenant(db, { tenantId: tenantB.id, name: 'B Renamed', actor: self(carol) });
    for (const action of [
      'invitation.created',
      'invitation.accepted',
      'tenant.member_added',
      'tenant.role_changed',
      'tenant.member_removed',
    ]) {
      expect(tenantOfEvents(action), action).toContain(tenantA.id);
    }
    // the joined account is made for the tenant it joins, not the one it was invited by
    expect(tenantOfEvents('account.created').slice(-1)).toEqual([tenantA.id]);
    expect(tenantOfEvents('tenant.renamed')).toEqual([tenantB.id]);
    expect(
      stamped()
        .filter((e) => e.tenantId === tenantB.id)
        .map((e) => e.action),
    ).not.toContain('tenant.role_changed');
  });

  it('stamps a vendor invitation, its withdrawal and its acceptance with the inviting tenant, and the new vendor account with it too', () => {
    const first = createInvitation(db, {
      tenantId: tenantA.id,
      invitedBy: alice.id,
      email: 'w1@example.com',
      actor: self(alice),
    });
    revokeInvitation(db, {
      tenantId: tenantA.id,
      id: first.invitation.id,
      actor: self(alice),
    });
    const second = createInvitation(db, {
      tenantId: tenantA.id,
      invitedBy: alice.id,
      email: 'w2@example.com',
      actor: self(alice),
    });
    acceptInvitation(db, { token: second.token, passwordHash: hash });
    const mine = stamped()
      .filter((e) => e.tenantId === tenantA.id)
      .map((e) => e.action);
    expect(mine.filter((a) => a === 'invitation.created')).toHaveLength(2);
    expect(mine).toContain('invitation.revoked');
    expect(mine).toContain('invitation.accepted');
    expect(tenantOfEvents('account.created').slice(-1)).toEqual([tenantA.id]);
  });

  it('stamps a staff login with the tenant, and a vendor login, a refused login and an operator write with none', () => {
    createAccountSession(db, alice.id, generateSessionToken(), { actor: self(alice) });
    const out = generateSessionToken();
    createAccountSession(db, vendor.id, out, { actor: self(vendor) });
    deleteAccountSession(db, out, { actor: self(vendor) });
    recordFailedLogin(db, {
      actor: TEST_ACTOR,
      accountId: alice.id,
      reason: 'wrong_password',
    });
    expect(tenantOfEvents('auth.login')).toEqual([tenantA.id, null]);
    expect(tenantOfEvents('auth.logout')).toEqual([null]);
    expect(tenantOfEvents('auth.login_failed')).toEqual([null]);
  });

  it('stamps a project, its grant and its download with the project’s own tenant, never the actor’s', () => {
    const project = { tenantId: tenantB.id, name: 'job' };
    recordProjectChange(
      db,
      'project.created',
      { actor: self(carol), project },
      () => undefined,
    );
    grantProjectAuthorization(db, {
      accountId: vendor.id,
      project,
      scope: 'assigned_translator',
      actor: self(carol),
    });
    recordDownload(db, {
      actor: self(carol),
      project,
      fileId: 1,
      name: 'x.docx',
      sha256: 'a'.repeat(64),
    });
    recordProjectChange(
      db,
      'project.deleted',
      { actor: self(carol), project },
      () => undefined,
    );
    for (const action of [
      'project.created',
      'authorization.granted',
      'file.downloaded',
      'project.deleted',
    ]) {
      expect(tenantOfEvents(action), action).toEqual([tenantB.id]);
    }
  });

  it('stamps a client’s consent with the tenant that holds the client', () => {
    setClientEngineConsent(db, {
      tenantId: tenantA.id,
      clientId: 7,
      engine: 'tessera',
      consent: true,
      actor: self(alice),
    });
    setClientEngineConsent(db, {
      tenantId: tenantB.id,
      clientId: 7,
      engine: 'tessera',
      consent: true,
      actor: self(carol),
    });
    expect(tenantOfEvents('client_engine.changed')).toEqual([tenantA.id, tenantB.id]);
  });

  it('cannot be written without saying which tenant, or that none', () => {
    const unnamed = {
      actor: TEST_ACTOR,
      action: 'tenant.renamed',
      subjectType: 'tenant',
      subjectId: '1',
      detail: null,
    } as const;
    // @ts-expect-error a platform write must name its tenant, as it must name its actor
    appendPlatformEvent(db, unnamed);
    // the compiler is the guard; what reaches the table is an event about no tenant
    expect(stamped().at(-1)).toMatchObject({ action: 'tenant.renamed', tenantId: null });
  });
});

describe('listTenantEvents', () => {
  it('shows a tenant its own events, newest first, and nothing of another tenant or of none', () => {
    const a = listTenantEvents(db, tenantA.id);
    const b = listTenantEvents(db, tenantB.id);
    expect(a.map((e) => e.action)).toEqual(['account.created', 'tenant.created']);
    expect(b.map((e) => e.action)).toEqual(['account.created', 'tenant.created']);
    expect(
      a.every((e) => e.subjectId !== String(tenantB.id) || e.subjectType !== 'tenant'),
    ).toBe(true);
    // the operator's own vendor account is about no tenant, so it is in nobody's slice
    const all = [...a, ...b].map((e) => e.id);
    expect(all).not.toContain(1);
  });

  it('pages by id and parses the detail, and caps a request', () => {
    for (let i = 0; i < 5; i++) {
      createStaffInvitation(db, {
        tenantId: tenantA.id,
        invitedBy: alice.id,
        email: `p${i}@example.com`,
        role: 'pm',
        actor: self(alice),
      });
    }
    const first = listTenantEvents(db, tenantA.id, { limit: 3 });
    expect(first).toHaveLength(3);
    const next = listTenantEvents(db, tenantA.id, { limit: 3, beforeId: first[2]!.id });
    expect(next.every((e) => e.id < first[2]!.id)).toBe(true);
    expect(new Set([...first, ...next].map((e) => e.id)).size).toBe(
      first.length + next.length,
    );
    expect(
      listTenantEvents(db, tenantA.id, { limit: 100000 }).length,
    ).toBeLessThanOrEqual(500);
    const revoked = listTenantEvents(db, tenantA.id).find(
      (e) => e.action === 'invitation.created',
    );
    expect(revoked?.detail).toBeNull();
  });

  it('carries no address in what it returns, for an event about a person', () => {
    const { token } = createStaffInvitation(db, {
      tenantId: tenantA.id,
      invitedBy: alice.id,
      email: 'pat@example.com',
      role: 'pm',
      actor: self(alice),
    });
    acceptStaffInvitation(db, { token, passwordHash: hash });
    const text = JSON.stringify(
      listTenantEvents(db, tenantA.id).map((e) => [e.action, e.detail, e.subjectId]),
    );
    expect(text).not.toContain('pat@example.com');
  });
});

describe('the tenant id is in the hash', () => {
  it('keeps the chain intact across the migration that adds it, for events written before it', () => {
    const path = join(dir, 'old.sqlite');
    const old = openAndMigrate(path, {
      applicationId: PLATFORM_APPLICATION_ID,
      migrations: PLATFORM_MIGRATIONS.slice(0, 10),
    });
    for (const i of [1, 2, 3]) {
      appendAuditEvent(old, {
        actor: TEST_ACTOR,
        action: 'tenant.renamed',
        subjectType: 'tenant',
        subjectId: String(i),
        detail: null,
      });
    }
    expect(verifyAudit(old)).toEqual({ events: 3, brokenAt: null });
    old.close();

    const migrated = openPlatformDb(path);
    expect(verifyAudit(migrated)).toEqual({ events: 3, brokenAt: null });
    expect(
      migrated
        .prepare('SELECT COUNT(*) AS n FROM audit_event WHERE tenant_id IS NOT NULL')
        .get(),
    ).toEqual({ n: 0 });
    // and goes on: a new event with a tenant chains onto the old head
    appendPlatformEvent(migrated, {
      actor: TEST_ACTOR,
      action: 'tenant.renamed',
      tenantId: 5,
      subjectType: 'tenant',
      subjectId: '5',
      detail: null,
    });
    expect(verifyAudit(migrated)).toEqual({ events: 4, brokenAt: null });
    migrated.close();
  });

  it('refuses to move an event to another tenant, and a forced move is found by verification', () => {
    const target = stamped().find((e) => e.tenantId === tenantA.id)!;
    expect(() =>
      db
        .prepare('UPDATE audit_event SET tenant_id = ? WHERE id = ?')
        .run(tenantB.id, target.id),
    ).toThrow(/append-only/);
    // someone with the file and sqlite3 can drop the trigger; the chain is what shows it
    db.exec('DROP TRIGGER audit_event_no_update');
    db.prepare('UPDATE audit_event SET tenant_id = ? WHERE id = ?').run(
      tenantB.id,
      target.id,
    );
    expect(verifyAudit(db).brokenAt).toBe(target.id);
  });

  it('is in the platform table only: a project, portal or roster log holds one tenant\u2019s events already', () => {
    const names = (ddl: string) => {
      const scratch = new Database(':memory:');
      scratch.exec(ddl);
      const cols = scratch
        .prepare("SELECT name FROM pragma_table_info('audit_event')")
        .all() as Array<{ name: string }>;
      scratch.close();
      return cols.map((c) => c.name);
    };
    expect(names(auditEventDdl(['tenant.renamed']))).not.toContain('tenant_id');
    expect(names(auditEventDdl(['tenant.renamed'], { tenantId: true }))).toContain(
      'tenant_id',
    );
    const platform = db
      .prepare("SELECT name FROM pragma_table_info('audit_event')")
      .all() as Array<{ name: string }>;
    expect(platform.map((c) => c.name)).toContain('tenant_id');
  });
});

describe('exportTenantAudit', () => {
  it('hands over exactly one tenant\u2019s rows as stored, with a header saying the whole log verified', () => {
    const out = exportTenantAudit(db, { tenantId: tenantA.id, actor: TEST_ACTOR });
    const lines = out.text
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({
      kind: 'tessera.tenant-audit',
      tenant_id: tenantA.id,
      events: lines.length - 1,
      whole_log_intact: true,
    });
    const rows = lines.slice(1);
    expect(rows.length).toBe(out.events);
    expect(rows.every((r) => r.tenant_id === tenantA.id)).toBe(true);
    expect(rows.map((r) => r.id)).toEqual(
      [...rows.map((r) => r.id as number)].sort((a, b) => a - b),
    );
    // as stored: a holder can recompute the hashes from the row
    expect(rows[0]).toHaveProperty('chain_hash');
    expect(JSON.stringify(rows)).not.toContain('alice@example.com');
    expect(out.sha256).toBe(createHash('sha256').update(out.text, 'utf8').digest('hex'));
  });

  it('logs itself, with a count and a digest and no event, in the tenant\u2019s own slice, and the log still verifies', () => {
    const out = exportTenantAudit(db, { tenantId: tenantB.id, actor: TEST_ACTOR });
    const logged = stamped().filter((e) => e.action === 'tenant.audit_exported');
    expect(logged).toEqual([
      expect.objectContaining({ tenantId: tenantB.id, subjectId: String(tenantB.id) }),
    ]);
    const detail = listTenantEvents(db, tenantB.id)[0]!;
    expect(detail.action).toBe('tenant.audit_exported');
    expect(detail.detail).toEqual({ events: out.events, sha256: out.sha256 });
    expect(JSON.stringify(out.text)).not.toContain('tenant.audit_exported');
    expect(verifyAudit(db).brokenAt).toBeNull();
    // another tenant's slice never carries it
    expect(listTenantEvents(db, tenantA.id).map((e) => e.action)).not.toContain(
      'tenant.audit_exported',
    );
  });

  it('reports a log that does not verify, and refuses a tenant that does not exist', () => {
    db.exec('DROP TRIGGER audit_event_no_update');
    db.prepare("UPDATE audit_event SET subject_id = 'x' WHERE id = 1").run();
    const out = exportTenantAudit(db, { tenantId: tenantA.id, actor: TEST_ACTOR });
    expect(JSON.parse(out.text.split('\n')[0]!)).toMatchObject({
      whole_log_intact: false,
    });
    expect(() => exportTenantAudit(db, { tenantId: 9999, actor: TEST_ACTOR })).toThrow(
      /no tenant/,
    );
  });
});
