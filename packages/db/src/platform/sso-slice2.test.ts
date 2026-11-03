/**
 * Single sign-on, slice 2 (issue #317, `planning/sso-spec.md` D3, D7, §2a): an invitation accepted
 * by a provider, and a tenant's policy. Written before the code that enforces each rule.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashPassword, NO_PASSWORD_HASH, type SsoIdentity } from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { verifyAudit } from '../audit/events.js';
import {
  acceptInvitation,
  acceptStaffInvitation,
  claimSsoCallback,
  completeSsoCallback,
  createAccount,
  createInvitation,
  createSsoAttempt,
  createStaffInvitation,
  findAccountByIdentity,
  getAccountByEmail,
  getSsoPolicy,
  IdentityTakenError,
  linkIdentity,
  openPlatformDb,
  openStaffInvitation,
  redeemSsoHandoff,
  setSsoPolicy,
  SsoLockoutError,
  staffIdentityAllowed,
  staffPasswordRefused,
  tenantOfAccount,
  type Account,
} from './index.js';

let dir: string;
let db: Database.Database;
let vendor: Account;
let admin: Account;
let tenantId: number;

const TID = '6f1b2c3d-1111-4222-8333-944455556666';
const OTHER_TID = '0a0b0c0d-1111-4222-8333-944455556666';
const msIdentity = (subject: string, tid = TID): SsoIdentity => ({
  provider: 'microsoft',
  issuer: `https://login.microsoftonline.com/${tid}/v2.0`,
  subject,
  directory: tid,
  hostedDomain: null,
});
const googleIdentity = (subject: string, hd: string | null = null): SsoIdentity => ({
  provider: 'google',
  issuer: 'https://accounts.google.com',
  subject,
  directory: null,
  hostedDomain: hd,
});
const adminActor = () => ({
  actor: { kind: 'account' as const, id: admin.id },
  label: admin.email,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-sso2-'));
  db = openPlatformDb(join(dir, 'platform.sqlite'));
  // A vendor first, so the tenant's id is not its founder's account id (CLAUDE.md, Tenants).
  vendor = createAccount(db, {
    email: 'vendor@example.com',
    passwordHash: hashPassword('pw'),
    role: 'vendor',
    actor: TEST_ACTOR,
  });
  admin = createAccount(db, {
    email: 'admin@example.com',
    passwordHash: hashPassword('pw'),
    actor: TEST_ACTOR,
  });
  tenantId = tenantOfAccount(db, admin.id)!;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const inviteStaff = (email = 'pat@example.com') =>
  createStaffInvitation(db, {
    tenantId,
    invitedBy: admin.id,
    email,
    role: 'pm',
    actor: adminActor(),
  }).token;

describe('an invitation accepted by a provider', () => {
  it('makes a staff account with no password and the identity linked, in one step', () => {
    const token = inviteStaff();
    const { account } = acceptStaffInvitation(db, {
      token,
      identity: googleIdentity('g-pat', 'example.org'),
    });
    expect(account.passwordHash).toBe(NO_PASSWORD_HASH);
    expect(tenantOfAccount(db, account.id)).toBe(tenantId);
    expect(findAccountByIdentity(db, googleIdentity('g-pat'))?.id).toBe(account.id);
    expect(
      db
        .prepare('SELECT hosted_domain FROM account_identity WHERE account_id = ?')
        .get(account.id),
    ).toEqual({ hosted_domain: 'example.org' });
    expect(verifyAudit(db).brokenAt).toBeNull();
  });

  it('leaves the invitation pending and makes nothing when the identity opens another account', () => {
    linkIdentity(db, admin.id, googleIdentity('g-taken'), { actor: adminActor() });
    const token = inviteStaff();
    expect(() =>
      acceptStaffInvitation(db, { token, identity: googleIdentity('g-taken') }),
    ).toThrow(IdentityTakenError);
    expect(getAccountByEmail(db, 'pat@example.com')).toBeNull();
    expect(openStaffInvitation(db, token)).not.toBeNull();
  });

  it('makes a vendor account the same way, on the inviting tenant’s roster', () => {
    const { token } = createInvitation(db, {
      tenantId,
      invitedBy: admin.id,
      email: 'freelance@example.com',
      actor: adminActor(),
    });
    const { account } = acceptInvitation(db, { token, identity: msIdentity('m-free') });
    expect(account.role).toBe('vendor');
    expect(account.passwordHash).toBe(NO_PASSWORD_HASH);
    expect(findAccountByIdentity(db, msIdentity('m-free'))?.id).toBe(account.id);
  });
});

describe('the identity a hand-off code carries back', () => {
  it('names the Microsoft directory and the Google domain it was signed in with', () => {
    const round = (identity: SsoIdentity, state: string) => {
      createSsoAttempt(db, {
        state,
        binding: 'a-browser-secret-0123456789',
        nonce: 'n',
        codeVerifier: 'v',
        provider: identity.provider,
        purpose: 'staff_invite',
        tenantId,
        accountId: null,
      });
      const attempt = claimSsoCallback(db, state)!;
      completeSsoCallback(db, attempt.id, identity, `code-${state}`);
      return redeemSsoHandoff(db, `code-${state}`, {
        tenantId,
        purpose: 'staff_invite',
        accountId: null,
        binding: 'a-browser-secret-0123456789',
      });
    };
    expect(round(msIdentity('m1'), 's1')).toMatchObject({
      directory: TID,
      hostedDomain: null,
    });
    expect(round(googleIdentity('g1', 'example.org'), 's2')).toMatchObject({
      directory: null,
      hostedDomain: 'example.org',
    });
  });
});

describe('a tenant’s single sign-on policy', () => {
  it('is absent until set, and refuses to require SSO of an admin with no way in by it', () => {
    expect(getSsoPolicy(db, tenantId)).toBeNull();
    const set = (microsoftTid: string | null = null, googleHd: string | null = null) =>
      setSsoPolicy(
        db,
        tenantId,
        { requireSso: true, microsoftTid, googleHd },
        { actor: adminActor(), accountId: admin.id },
      );
    expect(() => set()).toThrow(SsoLockoutError);
    linkIdentity(db, admin.id, msIdentity('m-admin', OTHER_TID), { actor: adminActor() });
    // a link outside the lock does not count
    expect(() => set(TID)).toThrow(SsoLockoutError);
    expect(getSsoPolicy(db, tenantId)).toBeNull();
    linkIdentity(db, admin.id, msIdentity('m-admin-2'), { actor: adminActor() });
    expect(set(TID.toUpperCase())).toMatchObject({ requireSso: true, microsoftTid: TID });
  });

  it('never refuses locks alone or switching it off, and logs each change once with its values', () => {
    const policy = { requireSso: false, microsoftTid: null, googleHd: 'Example.org' };
    const opts = { actor: adminActor(), accountId: admin.id };
    setSsoPolicy(db, tenantId, policy, opts);
    setSsoPolicy(db, tenantId, policy, opts);
    const logged = db
      .prepare(
        "SELECT tenant_id, detail FROM audit_event WHERE action = 'tenant.sso_policy_set'",
      )
      .all() as Array<{ tenant_id: number; detail: string }>;
    expect(logged).toHaveLength(1);
    expect(logged[0]!.tenant_id).toBe(tenantId);
    expect(JSON.parse(logged[0]!.detail)).toEqual({
      require_sso: false,
      microsoft_tid: null,
      google_hd: 'example.org',
    });
    expect(verifyAudit(db).brokenAt).toBeNull();
  });

  it('refuses a directory that is not a GUID and a domain that is not a host name', () => {
    const opts = { actor: adminActor(), accountId: admin.id };
    expect(() =>
      setSsoPolicy(
        db,
        tenantId,
        { requireSso: false, microsoftTid: 'nope', googleHd: null },
        opts,
      ),
    ).toThrow(RangeError);
    expect(() =>
      setSsoPolicy(
        db,
        tenantId,
        { requireSso: false, microsoftTid: null, googleHd: 'not a domain' },
        opts,
      ),
    ).toThrow(RangeError);
  });

  it('refuses a password only to staff who hold a link that would let them in, and never to a vendor', () => {
    linkIdentity(db, admin.id, googleIdentity('g-admin', 'example.org'), {
      actor: adminActor(),
    });
    const pat = acceptStaffInvitation(db, {
      token: inviteStaff(),
      passwordHash: hashPassword('pw'),
    }).account;
    linkIdentity(db, pat.id, googleIdentity('g-pat', 'elsewhere.org'), {
      actor: adminActor(),
    });
    linkIdentity(db, vendor.id, googleIdentity('g-vendor', 'example.org'), {
      actor: TEST_ACTOR,
    });
    expect(staffPasswordRefused(db, admin.id)).toBe(false);
    setSsoPolicy(
      db,
      tenantId,
      { requireSso: true, microsoftTid: null, googleHd: 'example.org' },
      { actor: adminActor(), accountId: admin.id },
    );
    expect(staffPasswordRefused(db, admin.id)).toBe(true);
    // Pat's only link is outside the lock: their password still works, so nobody is shut out.
    expect(staffPasswordRefused(db, pat.id)).toBe(false);
    expect(staffPasswordRefused(db, vendor.id)).toBe(false);
  });

  it('lets a staff sign-in through only inside the lock, and every vendor sign-in', () => {
    setSsoPolicy(
      db,
      tenantId,
      { requireSso: false, microsoftTid: TID, googleHd: null },
      { actor: adminActor(), accountId: admin.id },
    );
    expect(staffIdentityAllowed(db, admin.id, msIdentity('x'))).toBe(true);
    expect(staffIdentityAllowed(db, admin.id, msIdentity('x', OTHER_TID))).toBe(false);
    expect(staffIdentityAllowed(db, admin.id, googleIdentity('x'))).toBe(true);
    expect(staffIdentityAllowed(db, vendor.id, msIdentity('x', OTHER_TID))).toBe(true);
  });
});
