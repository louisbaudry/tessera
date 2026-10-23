/**
 * Staff of a tenant (backlog #206, `planning/tenant-spec.md` D2, D5, §6): who is on a
 * tenant, in which role, how a person joins by a one-time link, and the invariants the
 * schema holds itself: a tenant keeps an admin, and a link attaches only to the tenant
 * that issued it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashPassword } from '@cat-tool/core';
import { INVITATION_TTL_MS } from '@cat-tool/vendor-core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { verifyAudit } from '../audit/events.js';
import { createAccount, createAccountSession, type Account } from './accounts.js';
import { createTenant } from './create-tenant.js';
import { openPlatformDb } from './index.js';
import {
  acceptStaffInvitation,
  createStaffInvitation,
  listStaffInvitations,
  openStaffInvitation,
  revokeStaffInvitation,
  StaffInvitationError,
} from './staff-invitations.js';
import {
  changeTenantRole,
  getTenantForAccount,
  listTenantStaff,
  removeTenantStaff,
  TenantError,
  type Tenant,
} from './tenants.js';
import { EmailTakenError, InvitationUnusableError } from './invitations.js';

let dir: string;
let db: Database.Database;
let alice: Account; // admin of tenant A
let tenantA: Tenant;
let tenantB: Tenant;
let carol: Account; // admin of tenant B
let vendor: Account;

const T0 = new Date('2026-10-20T10:00:00.000Z');
const PASSWORD_HASH = hashPassword('a long enough password');
const hash = hashPassword('x');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-staff-'));
  db = openPlatformDb(join(dir, 'platform.sqlite'));
  // a vendor first, so no tenant id equals its founder's account id
  vendor = createAccount(db, {
    email: 'v@example.com',
    passwordHash: hash,
    role: 'vendor',
    actor: TEST_ACTOR,
  });
  const a = createTenant(db, {
    name: 'Tenant A',
    email: 'alice@example.com',
    passwordHash: hash,
    actor: TEST_ACTOR,
  });
  const b = createTenant(db, {
    name: 'Tenant B',
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

const events = () =>
  db
    .prepare(
      'SELECT action, subject_type AS subjectType, subject_id AS subjectId, detail FROM audit_event ORDER BY id',
    )
    .all() as Array<{
    action: string;
    subjectType: string;
    subjectId: string | null;
    detail: string | null;
  }>;

const invite = (email = 'Pat@Example.com', role: 'admin' | 'pm' = 'pm', now = T0) =>
  createStaffInvitation(db, {
    tenantId: tenantA.id,
    invitedBy: alice.id,
    email,
    role,
    actor: { actor: { kind: 'account', id: alice.id }, label: alice.email },
    now,
  });

describe('inviting staff', () => {
  it('returns the token once, stores only its hash, and logs the invitation with no address', () => {
    const { invitation, token } = invite();
    expect(invitation).toMatchObject({
      tenantId: tenantA.id,
      invitedBy: alice.id,
      email: 'pat@example.com',
      role: 'pm',
      status: 'pending',
    });
    const row = db.prepare('SELECT token_hash FROM staff_invitation').get() as {
      token_hash: string;
    };
    expect(row.token_hash).not.toContain(token);
    const created = events().find(
      (e) => e.action === 'invitation.created' && e.subjectType === 'staff_invitation',
    );
    expect(created).toMatchObject({ subjectId: String(invitation.id), detail: null });
  });

  it('refuses a bad address, an unknown role, and an inviter who is not staff of that tenant', () => {
    expect(() => invite('not an address')).toThrow(StaffInvitationError);
    expect(() => invite('x@example.com', 'owner' as never)).toThrow(StaffInvitationError);
    expect(() =>
      createStaffInvitation(db, {
        tenantId: tenantA.id,
        invitedBy: carol.id,
        email: 'x@example.com',
        role: 'pm',
        actor: TEST_ACTOR,
      }),
    ).toThrow(StaffInvitationError);
    expect(() =>
      createStaffInvitation(db, {
        tenantId: tenantA.id,
        invitedBy: vendor.id,
        email: 'x@example.com',
        role: 'pm',
        actor: TEST_ACTOR,
      }),
    ).toThrow(StaffInvitationError);
  });

  it('withdraws an earlier pending link for the same address when one is made again', () => {
    const first = invite('pat@example.com');
    const second = invite('PAT@example.com', 'pm', new Date(T0.getTime() + 1000));
    const listed = listStaffInvitations(db, tenantA.id, new Date(T0.getTime() + 2000));
    expect(listed.map((i) => [i.id, i.status])).toEqual([
      [second.invitation.id, 'pending'],
      [first.invitation.id, 'revoked'],
    ]);
  });

  it('lists only the tenant’s own', () => {
    invite('a@example.com');
    createStaffInvitation(db, {
      tenantId: tenantB.id,
      invitedBy: carol.id,
      email: 'b@example.com',
      role: 'pm',
      actor: TEST_ACTOR,
      now: T0,
    });
    expect(listStaffInvitations(db, tenantA.id, T0).map((i) => i.email)).toEqual([
      'a@example.com',
    ]);
    expect(listStaffInvitations(db, tenantB.id, T0).map((i) => i.email)).toEqual([
      'b@example.com',
    ]);
  });
});

describe('accepting a staff link', () => {
  it('makes an account that is staff of the inviting tenant, in the invited role, founding no tenant', () => {
    const { token, invitation } = invite('pat@example.com', 'pm');
    const accounts = db.prepare('SELECT COUNT(*) AS n FROM account').get() as {
      n: number;
    };
    const tenants = db.prepare('SELECT COUNT(*) AS n FROM tenant').get() as { n: number };
    const { account } = acceptStaffInvitation(db, {
      token,
      passwordHash: PASSWORD_HASH,
      now: new Date(T0.getTime() + 1),
    });
    expect(account.role).toBe('owner');
    expect(getTenantForAccount(db, account.id)).toEqual({ tenant: tenantA, role: 'pm' });
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM account').get() as { n: number }).n,
    ).toBe(accounts.n + 1);
    // joining is not founding: no second tenant
    expect(db.prepare('SELECT COUNT(*) AS n FROM tenant').get()).toEqual(tenants);
    expect(listStaffInvitations(db, tenantA.id, T0)[0]).toMatchObject({
      id: invitation.id,
      status: 'accepted',
    });
  });

  it('logs the account, the membership and the acceptance, with no address in any detail', () => {
    const { token } = invite('pat@example.com', 'admin');
    const { account } = acceptStaffInvitation(db, {
      token,
      passwordHash: PASSWORD_HASH,
      now: new Date(T0.getTime() + 1),
    });
    const log = events();
    const added = log.find((e) => e.action === 'tenant.member_added');
    expect(added).toMatchObject({ subjectType: 'tenant', subjectId: String(tenantA.id) });
    expect(JSON.parse(added!.detail!)).toEqual({ account_id: account.id, role: 'admin' });
    expect(
      log.some(
        (e) => e.action === 'invitation.accepted' && e.subjectType === 'staff_invitation',
      ),
    ).toBe(true);
    expect(JSON.stringify(log)).not.toContain('pat@example.com');
    expect(verifyAudit(db)).toMatchObject({ brokenAt: null });
  });

  it('attaches only to the tenant that issued the link', () => {
    const { token } = invite('pat@example.com', 'pm');
    createStaffInvitation(db, {
      tenantId: tenantB.id,
      invitedBy: carol.id,
      email: 'pat2@example.com',
      role: 'pm',
      actor: TEST_ACTOR,
      now: T0,
    });
    const { account } = acceptStaffInvitation(db, {
      token,
      passwordHash: PASSWORD_HASH,
      now: new Date(T0.getTime() + 1),
    });
    expect(getTenantForAccount(db, account.id)?.tenant.id).toBe(tenantA.id);
    expect(listTenantStaff(db, tenantB.id).map((s) => s.accountId)).toEqual([carol.id]);
  });

  it('is single-use, and an unknown, withdrawn or expired link is one identical refusal', () => {
    const { token } = invite('a@example.com');
    acceptStaffInvitation(db, {
      token,
      passwordHash: PASSWORD_HASH,
      now: new Date(T0.getTime() + 1),
    });
    expect(() =>
      acceptStaffInvitation(db, {
        token,
        passwordHash: PASSWORD_HASH,
        now: new Date(T0.getTime() + 2),
      }),
    ).toThrow(InvitationUnusableError);
    const withdrawn = invite('w@example.com');
    revokeStaffInvitation(db, {
      tenantId: tenantA.id,
      id: withdrawn.invitation.id,
      actor: TEST_ACTOR,
      now: T0,
    });
    expect(() =>
      acceptStaffInvitation(db, {
        token: withdrawn.token,
        passwordHash: PASSWORD_HASH,
        now: T0,
      }),
    ).toThrow(InvitationUnusableError);
    const old = invite('e@example.com');
    expect(() =>
      acceptStaffInvitation(db, {
        token: old.token,
        passwordHash: PASSWORD_HASH,
        now: new Date(T0.getTime() + INVITATION_TTL_MS + 1),
      }),
    ).toThrow(InvitationUnusableError);
    expect(() =>
      acceptStaffInvitation(db, { token: 'nope', passwordHash: PASSWORD_HASH, now: T0 }),
    ).toThrow(InvitationUnusableError);
  });

  it('refuses an address that already has an account, leaving the link pending (one tenant per person)', () => {
    const { token, invitation } = invite('carol@example.com', 'pm');
    expect(() =>
      acceptStaffInvitation(db, {
        token,
        passwordHash: PASSWORD_HASH,
        now: new Date(T0.getTime() + 1),
      }),
    ).toThrow(EmailTakenError);
    expect(
      listStaffInvitations(db, tenantA.id, new Date(T0.getTime() + 2))[0],
    ).toMatchObject({ id: invitation.id, status: 'pending' });
    expect(getTenantForAccount(db, carol.id)?.tenant.id).toBe(tenantB.id);
  });

  it('opens to the address and nothing else, and only while pending', () => {
    const { token } = invite('pat@example.com');
    expect(openStaffInvitation(db, token, T0)).toEqual({ email: 'pat@example.com' });
    expect(openStaffInvitation(db, 'nope', T0)).toBeNull();
    expect(
      openStaffInvitation(db, token, new Date(T0.getTime() + INVITATION_TTL_MS + 1)),
    ).toBeNull();
  });

  it('revoking is the tenant’s own: another tenant’s and a missing id are the same error', () => {
    const { invitation } = invite();
    expect(() =>
      revokeStaffInvitation(db, {
        tenantId: tenantB.id,
        id: invitation.id,
        actor: TEST_ACTOR,
      }),
    ).toThrow(StaffInvitationError);
    expect(() =>
      revokeStaffInvitation(db, { tenantId: tenantA.id, id: 9999, actor: TEST_ACTOR }),
    ).toThrow(StaffInvitationError);
  });
});

describe('a tenant keeps an admin (spec §6, invariant 4)', () => {
  const join = (email: string, role: 'admin' | 'pm') => {
    const { token } = invite(email, role);
    return acceptStaffInvitation(db, {
      token,
      passwordHash: PASSWORD_HASH,
      now: new Date(T0.getTime() + 1),
    }).account;
  };

  it('refuses to remove or demote the last admin, in the schema and in the repository', () => {
    expect(() =>
      removeTenantStaff(db, {
        tenantId: tenantA.id,
        accountId: alice.id,
        actor: TEST_ACTOR,
      }),
    ).toThrow(TenantError);
    expect(() =>
      changeTenantRole(db, {
        tenantId: tenantA.id,
        accountId: alice.id,
        role: 'pm',
        actor: TEST_ACTOR,
      }),
    ).toThrow(TenantError);
    // and not around the repository either
    expect(() =>
      db.prepare('DELETE FROM tenant_membership WHERE account_id = ?').run(alice.id),
    ).toThrow(/at least one admin/);
    expect(() =>
      db
        .prepare("UPDATE tenant_membership SET role = 'pm' WHERE account_id = ?")
        .run(alice.id),
    ).toThrow(/at least one admin/);
    expect(getTenantForAccount(db, alice.id)?.role).toBe('admin');
  });

  it('lets an admin go once another admin exists, and a pm go at any time', () => {
    const pat = join('pat@example.com', 'pm');
    const sam = join('sam@example.com', 'admin');
    removeTenantStaff(db, { tenantId: tenantA.id, accountId: pat.id, actor: TEST_ACTOR });
    changeTenantRole(db, {
      tenantId: tenantA.id,
      accountId: alice.id,
      role: 'pm',
      actor: TEST_ACTOR,
    });
    expect(listTenantStaff(db, tenantA.id).map((s) => [s.accountId, s.role])).toEqual([
      [alice.id, 'pm'],
      [sam.id, 'admin'],
    ]);
    // sam is now the last admin
    expect(() =>
      removeTenantStaff(db, {
        tenantId: tenantA.id,
        accountId: sam.id,
        actor: TEST_ACTOR,
      }),
    ).toThrow(TenantError);
  });

  it('does not touch another tenant’s staff, and says the same for a stranger as for a missing account', () => {
    const pat = join('pat@example.com', 'pm');
    expect(() =>
      removeTenantStaff(db, {
        tenantId: tenantB.id,
        accountId: pat.id,
        actor: TEST_ACTOR,
      }),
    ).toThrow(TenantError);
    expect(() =>
      removeTenantStaff(db, { tenantId: tenantA.id, accountId: 9999, actor: TEST_ACTOR }),
    ).toThrow(TenantError);
    expect(() =>
      changeTenantRole(db, {
        tenantId: tenantB.id,
        accountId: pat.id,
        role: 'admin',
        actor: TEST_ACTOR,
      }),
    ).toThrow(TenantError);
    expect(getTenantForAccount(db, pat.id)?.tenant.id).toBe(tenantA.id);
  });

  it('logs a role change and a removal by account id, and ends the removed person’s sessions', () => {
    const pat = join('pat@example.com', 'pm');
    createAccountSession(db, pat.id, 'tok-pat', {
      actor: { actor: { kind: 'account', id: pat.id }, label: null },
    });
    changeTenantRole(db, {
      tenantId: tenantA.id,
      accountId: pat.id,
      role: 'admin',
      actor: TEST_ACTOR,
    });
    removeTenantStaff(db, { tenantId: tenantA.id, accountId: pat.id, actor: TEST_ACTOR });
    const log = events();
    const changed = log.find((e) => e.action === 'tenant.role_changed');
    expect(JSON.parse(changed!.detail!)).toEqual({
      account_id: pat.id,
      from: 'pm',
      to: 'admin',
    });
    const removed = log.find((e) => e.action === 'tenant.member_removed');
    expect(JSON.parse(removed!.detail!)).toEqual({ account_id: pat.id });
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM account_session WHERE account_id = ?')
        .get(pat.id),
    ).toEqual({ n: 0 });
    expect(getTenantForAccount(db, pat.id)).toBeNull();
  });

  it('writes nothing when a role is set to what it already is', () => {
    const before = events().length;
    changeTenantRole(db, {
      tenantId: tenantA.id,
      accountId: alice.id,
      role: 'admin',
      actor: TEST_ACTOR,
    });
    expect(events()).toHaveLength(before);
  });
});

describe('listing staff', () => {
  it('lists a tenant’s staff in the order they joined, with role and address, and no other tenant’s', () => {
    const { token } = invite('pat@example.com', 'pm');
    const pat = acceptStaffInvitation(db, {
      token,
      passwordHash: PASSWORD_HASH,
      now: new Date(T0.getTime() + 1),
    }).account;
    expect(listTenantStaff(db, tenantA.id)).toMatchObject([
      { accountId: alice.id, email: 'alice@example.com', role: 'admin' },
      { accountId: pat.id, email: 'pat@example.com', role: 'pm' },
    ]);
    expect(listTenantStaff(db, tenantB.id).map((s) => s.accountId)).toEqual([carol.id]);
  });
});
