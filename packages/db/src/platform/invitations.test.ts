/**
 * An owner's invitation to become a vendor (backlog #111): a hashed, expiring,
 * single-use link that makes the account and the roster index row in one step.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashPassword, verifyPassword, type AuditActor } from '@cat-tool/core';
import { INVITATION_TTL_MS } from '@cat-tool/vendor-core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents, verifyAudit } from '../audit/events.js';
import { openAndMigrate } from '../migrate.js';
import { createAccount, getAccountByEmail, type Account } from './accounts.js';
import { openPlatformDb } from './index.js';
import {
  acceptInvitation,
  createInvitation,
  EmailTakenError,
  InvalidInvitationError,
  InvitationNotPendingError,
  InvitationRoleError,
  InvitationUnusableError,
  listAcceptedInvitations,
  joinInvitation,
  listInvitations,
  NoSuchInvitationError,
  openInvitation,
  revokeInvitation,
} from './invitations.js';
import { listRosterOwners } from './membership.js';
import { PLATFORM_APPLICATION_ID, PLATFORM_MIGRATIONS } from './schema.js';

let dir: string;
let db: Database.Database;
let alice: Account;
let dave: Account;
let aliceActor: AuditActor;

const T0 = new Date('2026-10-09T10:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);
const PASSWORD_HASH = hashPassword('a long enough password');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-invitations-'));
  db = openPlatformDb(join(dir, 'platform.sqlite'));
  alice = createAccount(db, {
    email: 'alice@example.com',
    passwordHash: 'h',
    actor: TEST_ACTOR,
  });
  dave = createAccount(db, {
    email: 'dave@example.com',
    passwordHash: 'h',
    actor: TEST_ACTOR,
  });
  aliceActor = { actor: { kind: 'account', id: alice.id }, label: alice.email };
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const invite = (email = 'Bob@Example.com', name?: string, now = T0) =>
  createInvitation(db, {
    ownerId: alice.id,
    email,
    displayName: name,
    actor: aliceActor,
    now,
  });

describe('inviting', () => {
  it('returns the token once and stores only its hash', () => {
    const { invitation, token } = invite('Bob@Example.com', '  Bob  ');
    expect(invitation).toMatchObject({
      ownerId: alice.id,
      email: 'bob@example.com',
      displayName: 'Bob',
      status: 'pending',
      acceptedAt: null,
    });
    expect(invitation.expiresAt).toBe(later(INVITATION_TTL_MS).toISOString());
    const stored = db.prepare('SELECT * FROM vendor_invitation').get() as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(String(stored.token_hash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a bad address, and an inviter who is not an owner', () => {
    expect(() => invite('not-an-address')).toThrow(InvalidInvitationError);
    const vendor = createAccount(db, {
      email: 'v@example.com',
      passwordHash: 'h',
      role: 'vendor',
      actor: TEST_ACTOR,
    });
    expect(() =>
      createInvitation(db, {
        ownerId: vendor.id,
        email: 'x@example.com',
        actor: TEST_ACTOR,
      }),
    ).toThrow(InvalidInvitationError);
  });

  it('logs invitation.created with the owner as actor and no email in the detail', () => {
    const { invitation } = invite();
    const [event] = listEvents(db, {
      subjectType: 'invitation',
      subjectId: String(invitation.id),
    });
    expect(event).toMatchObject({
      action: 'invitation.created',
      actor: `account:${alice.id}`,
      actorLabel: 'alice@example.com',
    });
    expect(JSON.stringify(event)).not.toContain('bob@example.com');
  });

  it('withdraws the earlier pending link for the same address when invited again', () => {
    const first = invite();
    const second = invite('bob@example.com', undefined, later(1000));
    expect(() => openInvitation(db, first.token, later(1000))).not.toThrow();
    expect(openInvitation(db, first.token, later(1000))).toBeNull();
    expect(openInvitation(db, second.token, later(1000))).toEqual({
      email: 'bob@example.com',
    });
    const events = listEvents(db, {
      subjectType: 'invitation',
      subjectId: String(first.invitation.id),
    });
    expect(events.map((e) => e.action)).toEqual([
      'invitation.created',
      'invitation.revoked',
    ]);
    expect(JSON.parse(events[1]!.detail ?? 'null')).toEqual({ superseded: true });
  });

  it('lists only the owner’s own, newest first, with a derived status', () => {
    invite('a@example.com');
    invite('b@example.com', undefined, later(1000));
    createInvitation(db, {
      ownerId: dave.id,
      email: 'c@example.com',
      actor: TEST_ACTOR,
      now: T0,
    });
    expect(listInvitations(db, alice.id, later(1000)).map((i) => i.email)).toEqual([
      'b@example.com',
      'a@example.com',
    ]);
    expect(
      listInvitations(db, alice.id, later(INVITATION_TTL_MS + 1001)).map((i) => i.status),
    ).toEqual(['expired', 'expired']);
  });
});

describe('accepting', () => {
  it('makes a vendor account, the roster index row and the used link in one step', () => {
    const { invitation, token } = invite();
    const { account } = acceptInvitation(db, {
      token,
      passwordHash: PASSWORD_HASH,
      now: later(60_000),
    });
    expect(account).toMatchObject({ email: 'bob@example.com', role: 'vendor' });
    expect(verifyPassword('a long enough password', account.passwordHash)).toBe(true);
    expect(getAccountByEmail(db, 'bob@example.com')?.id).toBe(account.id);
    expect(listRosterOwners(db, account.id)).toEqual([alice.id]);
    expect(listInvitations(db, alice.id, later(60_000))[0]).toMatchObject({
      id: invitation.id,
      status: 'accepted',
      acceptedAccountId: account.id,
    });
    expect(listAcceptedInvitations(db, alice.id)).toEqual([
      { accountId: account.id, displayName: null },
    ]);
  });

  it('is single-use: the second try is refused and makes no second account', () => {
    const { token } = invite();
    acceptInvitation(db, { token, passwordHash: PASSWORD_HASH, now: later(1) });
    expect(() =>
      acceptInvitation(db, { token, passwordHash: PASSWORD_HASH, now: later(2) }),
    ).toThrow(InvitationUnusableError);
    expect(db.prepare('SELECT COUNT(*) AS n FROM account').get()).toEqual({ n: 3 });
  });

  it('refuses a link that is expired, withdrawn or unknown, all with one error', () => {
    const expired = invite('e@example.com');
    const withdrawn = invite('w@example.com');
    revokeInvitation(db, {
      ownerId: alice.id,
      id: withdrawn.invitation.id,
      actor: aliceActor,
      now: later(5),
    });
    const accept = (token: string, now: Date) => () =>
      acceptInvitation(db, { token, passwordHash: PASSWORD_HASH, now });
    expect(accept(expired.token, later(INVITATION_TTL_MS))).toThrow(
      InvitationUnusableError,
    );
    expect(accept(withdrawn.token, later(10))).toThrow(InvitationUnusableError);
    expect(accept('no-such-token', later(10))).toThrow(InvitationUnusableError);
    expect(db.prepare('SELECT COUNT(*) AS n FROM account').get()).toEqual({ n: 2 });
  });

  it('leaves the link pending when the address already has an account', () => {
    const { token } = invite('dave@example.com');
    expect(() =>
      acceptInvitation(db, { token, passwordHash: PASSWORD_HASH, now: later(1) }),
    ).toThrow(EmailTakenError);
    expect(openInvitation(db, token, later(2))).toEqual({ email: 'dave@example.com' });
    expect(listRosterOwners(db, dave.id)).toEqual([]);
  });

  it('records the account by the owner who vouched and the acceptance by the new account', () => {
    const { invitation, token } = invite();
    const { account } = acceptInvitation(db, {
      token,
      passwordHash: PASSWORD_HASH,
      now: later(1),
    });
    const created = listEvents(db, {
      subjectType: 'account',
      subjectId: String(account.id),
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      action: 'account.created',
      actor: `account:${alice.id}`,
    });
    const events = listEvents(db, {
      subjectType: 'invitation',
      subjectId: String(invitation.id),
    });
    expect(events.map((e) => e.action)).toEqual([
      'invitation.created',
      'invitation.accepted',
    ]);
    expect(events[1]).toMatchObject({ actor: `account:${account.id}` });
    expect(JSON.parse(events[1]!.detail ?? 'null')).toEqual({
      owner_id: alice.id,
      account_id: account.id,
    });
    expect(verifyAudit(db).brokenAt).toBeNull();
  });

  it('keeps a used link final even if a write tries to reopen it', () => {
    const { invitation, token } = invite();
    acceptInvitation(db, { token, passwordHash: PASSWORD_HASH, now: later(1) });
    expect(() =>
      db
        .prepare(
          'UPDATE vendor_invitation SET accepted_at = NULL, accepted_account_id = NULL WHERE id = ?',
        )
        .run(invitation.id),
    ).toThrow(/final|CHECK/);
    expect(() =>
      db
        .prepare('UPDATE vendor_invitation SET expires_at = ? WHERE id = ?')
        .run('2099-01-01T00:00:00.000Z', invitation.id),
    ).toThrow(/final/);
  });
});

describe('opening and revoking', () => {
  it('shows only the address, and only for a link that can be used', () => {
    const { token } = invite();
    expect(openInvitation(db, token, later(1))).toEqual({ email: 'bob@example.com' });
    expect(openInvitation(db, token, later(INVITATION_TTL_MS))).toBeNull();
    expect(openInvitation(db, 'garbage', later(1))).toBeNull();
  });

  it('withdraws a pending link, logged with the owner, and refuses a second withdrawal', () => {
    const { invitation, token } = invite();
    const done = revokeInvitation(db, {
      ownerId: alice.id,
      id: invitation.id,
      actor: aliceActor,
      now: later(5),
    });
    expect(done.status).toBe('revoked');
    expect(openInvitation(db, token, later(6))).toBeNull();
    expect(() =>
      revokeInvitation(db, { ownerId: alice.id, id: invitation.id, actor: aliceActor }),
    ).toThrow(InvitationNotPendingError);
    expect(
      listEvents(db, { subjectType: 'invitation', subjectId: String(invitation.id) }).map(
        (e) => [e.action, e.actor],
      ),
    ).toEqual([
      ['invitation.created', `account:${alice.id}`],
      ['invitation.revoked', `account:${alice.id}`],
    ]);
  });

  it('gives another owner’s and a missing invitation the same error', () => {
    const { invitation } = invite();
    const actor: AuditActor = { actor: { kind: 'account', id: dave.id }, label: null };
    expect(() =>
      revokeInvitation(db, { ownerId: dave.id, id: invitation.id, actor }),
    ).toThrow(NoSuchInvitationError);
    expect(() =>
      revokeInvitation(db, { ownerId: alice.id, id: 9999, actor: aliceActor }),
    ).toThrow(NoSuchInvitationError);
    expect(listInvitations(db, alice.id, T0)[0]!.status).toBe('pending');
  });

  it('cannot withdraw a link already used', () => {
    const { invitation, token } = invite();
    acceptInvitation(db, { token, passwordHash: PASSWORD_HASH, now: later(1) });
    expect(() =>
      revokeInvitation(db, { ownerId: alice.id, id: invitation.id, actor: aliceActor }),
    ).toThrow(InvitationNotPendingError);
  });
});

describe('an existing vendor joins a second roster (backlog #187)', () => {
  const vera = () =>
    createAccount(db, {
      email: 'vera@example.com',
      passwordHash: PASSWORD_HASH,
      role: 'vendor',
      actor: TEST_ACTOR,
    });

  it('puts the signed-in vendor on the owner’s roster index without making an account', () => {
    const v = vera();
    const { token } = invite('vera@example.com', 'Vera');
    const before = db.prepare('SELECT COUNT(*) AS n FROM account').get();
    const done = joinInvitation(db, { token, accountId: v.id, now: later(1) });
    expect(db.prepare('SELECT COUNT(*) AS n FROM account').get()).toEqual(before);
    expect(done.account.id).toBe(v.id);
    expect(done.invitation).toMatchObject({
      status: 'accepted',
      acceptedAccountId: v.id,
    });
    expect(listRosterOwners(db, v.id)).toEqual([alice.id]);
    expect(listAcceptedInvitations(db, alice.id)).toEqual([
      { accountId: v.id, displayName: 'Vera' },
    ]);
  });

  it('keeps a vendor on both rosters when a second owner invites them', () => {
    const v = vera();
    const first = invite('vera@example.com');
    joinInvitation(db, { token: first.token, accountId: v.id, now: later(1) });
    const second = createInvitation(db, {
      ownerId: dave.id,
      email: 'vera@example.com',
      actor: { actor: { kind: 'account', id: dave.id }, label: null },
      now: T0,
    });
    joinInvitation(db, { token: second.token, accountId: v.id, now: later(2) });
    expect(listRosterOwners(db, v.id)).toEqual([alice.id, dave.id]);
  });

  it('is single-use, like any link', () => {
    const v = vera();
    const { token } = invite('vera@example.com');
    joinInvitation(db, { token, accountId: v.id, now: later(1) });
    expect(() => joinInvitation(db, { token, accountId: v.id, now: later(2) })).toThrow(
      InvitationUnusableError,
    );
  });

  it('refuses an account that is not the invited address, with the unusable-link error', () => {
    vera();
    const stranger = createAccount(db, {
      email: 'sam@example.com',
      passwordHash: PASSWORD_HASH,
      role: 'vendor',
      actor: TEST_ACTOR,
    });
    const { token } = invite('vera@example.com');
    expect(() =>
      joinInvitation(db, { token, accountId: stranger.id, now: later(1) }),
    ).toThrow(InvitationUnusableError);
    expect(() => joinInvitation(db, { token, accountId: 9999, now: later(1) })).toThrow(
      InvitationUnusableError,
    );
    expect(listRosterOwners(db, stranger.id)).toEqual([]);
    expect(openInvitation(db, token, later(2))).toEqual({ email: 'vera@example.com' }); // still pending
  });

  it('refuses an owner’s account, and leaves the link pending', () => {
    const { token } = invite('dave@example.com');
    expect(() =>
      joinInvitation(db, { token, accountId: dave.id, now: later(1) }),
    ).toThrow(InvitationRoleError);
    expect(listRosterOwners(db, dave.id)).toEqual([]);
    expect(openInvitation(db, token, later(2))).toEqual({ email: 'dave@example.com' });
  });

  it('refuses an unknown, withdrawn or expired link', () => {
    const v = vera();
    const withdrawn = invite('vera@example.com');
    revokeInvitation(db, {
      ownerId: alice.id,
      id: withdrawn.invitation.id,
      actor: aliceActor,
      now: later(1),
    });
    const expired = createInvitation(db, {
      ownerId: dave.id,
      email: 'vera@example.com',
      actor: TEST_ACTOR,
      now: T0,
    });
    const join = (token: string, now: Date) => () =>
      joinInvitation(db, { token, accountId: v.id, now });
    expect(join(withdrawn.token, later(2))).toThrow(InvitationUnusableError);
    expect(join(expired.token, later(INVITATION_TTL_MS))).toThrow(
      InvitationUnusableError,
    );
    expect(join('never-issued', later(2))).toThrow(InvitationUnusableError);
    expect(listRosterOwners(db, v.id)).toEqual([]);
  });

  it('logs invitation.accepted with the vendor as actor and marks it as an existing account', () => {
    const v = vera();
    const { invitation, token } = invite('vera@example.com');
    joinInvitation(db, { token, accountId: v.id, now: later(1) });
    const events = listEvents(db, {
      subjectType: 'invitation',
      subjectId: String(invitation.id),
    });
    expect(events.map((e) => e.action)).toEqual([
      'invitation.created',
      'invitation.accepted',
    ]);
    expect(events[1]).toMatchObject({ actor: `account:${v.id}` });
    expect(JSON.parse(events[1]!.detail ?? 'null')).toEqual({
      owner_id: alice.id,
      account_id: v.id,
      existing: true,
    });
    // no account was created by this invitation
    expect(
      listEvents(db, { subjectType: 'account', subjectId: String(v.id) }).map(
        (e) => e.actor,
      ),
    ).toEqual(['cli:test']);
    expect(verifyAudit(db).brokenAt).toBeNull();
  });
});

describe('the v6 migration', () => {
  it('keeps the audit chain when it widens the action list', () => {
    const path = join(dir, 'old.sqlite');
    const old = openAndMigrate(path, {
      applicationId: PLATFORM_APPLICATION_ID,
      migrations: PLATFORM_MIGRATIONS.slice(0, 5),
    });
    createAccount(old, { email: 'o@example.com', passwordHash: 'h', actor: TEST_ACTOR });
    const events = (d: Database.Database) =>
      d
        .prepare('SELECT id, action, chain_hash FROM audit_event ORDER BY id')
        .all() as Array<{ id: number; action: string; chain_hash: string }>;
    const before = events(old);
    expect(before).toHaveLength(1);
    old.close();

    const upgraded = openAndMigrate(path, {
      applicationId: PLATFORM_APPLICATION_ID,
      migrations: PLATFORM_MIGRATIONS,
    });
    try {
      expect(events(upgraded)).toEqual(before);
      const owner = getAccountByEmail(upgraded, 'o@example.com')!;
      createInvitation(upgraded, {
        ownerId: owner.id,
        email: 'v@example.com',
        actor: TEST_ACTOR,
      });
      expect(verifyAudit(upgraded)).toMatchObject({ events: 2, brokenAt: null });
    } finally {
      upgraded.close();
    }
  });
});
