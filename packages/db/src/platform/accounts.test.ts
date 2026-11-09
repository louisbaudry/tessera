import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  generateSessionToken,
  hashPassword,
  SESSION_TTL_MS,
  verifyPassword,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createAccount,
  createAccountSession,
  deleteAccountSession,
  getAccountByEmail,
  getAccountBySessionToken,
  listAccounts,
  setAccountPassword,
} from './accounts.js';
import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents, verifyAudit } from '../audit/events.js';
import { openPlatformDb } from './index.js';

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-accounts-'));
  db = openPlatformDb(join(dir, 'platform.sqlite'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('accounts', () => {
  it('mints an unguessable storage root per account, never one a caller chose', () => {
    const a = createAccount(db, {
      email: 'a@example.com',
      passwordHash: hashPassword('x'),
      actor: TEST_ACTOR,
    });
    const b = createAccount(db, {
      email: 'b@example.com',
      passwordHash: hashPassword('y'),
      actor: TEST_ACTOR,
    });
    expect(a.storageRoot).toMatch(/^u\/[0-9a-f]{24}$/);
    expect(b.storageRoot).not.toBe(a.storageRoot);
    expect(getAccountByEmail(db, 'a@example.com')).toEqual(a);
    expect(getAccountByEmail(db, 'nobody@example.com')).toBeNull();
    expect(listAccounts(db).map((x) => x.email)).toEqual([
      'a@example.com',
      'b@example.com',
    ]);
  });

  it('refuses a second account with the same email', () => {
    createAccount(db, { email: 'a@example.com', passwordHash: 'h', actor: TEST_ACTOR });
    expect(() =>
      createAccount(db, { email: 'a@example.com', passwordHash: 'h', actor: TEST_ACTOR }),
    ).toThrow(/UNIQUE/);
  });
});

describe('sessions', () => {
  it('finds the account by its live token and forgets it on logout', () => {
    const account = createAccount(db, {
      email: 'a@example.com',
      passwordHash: 'h',
      actor: TEST_ACTOR,
    });
    const token = generateSessionToken();
    const { expiresAt } = createAccountSession(db, account.id, token, {
      actor: TEST_ACTOR,
    });
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(getAccountBySessionToken(db, token)?.id).toBe(account.id);
    expect(getAccountBySessionToken(db, generateSessionToken())).toBeNull();

    expect(deleteAccountSession(db, token, { actor: TEST_ACTOR })).toBe(true);
    expect(getAccountBySessionToken(db, token)).toBeNull();
    expect(deleteAccountSession(db, token, { actor: TEST_ACTOR })).toBe(false);
  });

  it('expires after the shared TTL', () => {
    const account = createAccount(db, {
      email: 'a@example.com',
      passwordHash: 'h',
      actor: TEST_ACTOR,
    });
    const token = generateSessionToken();
    const issued = new Date('2026-01-01T00:00:00Z');
    createAccountSession(db, account.id, token, { actor: TEST_ACTOR, now: issued });
    const justBefore = new Date(issued.getTime() + SESSION_TTL_MS - 1);
    const justAfter = new Date(issued.getTime() + SESSION_TTL_MS);
    expect(getAccountBySessionToken(db, token, justBefore)).not.toBeNull();
    expect(getAccountBySessionToken(db, token, justAfter)).toBeNull();
  });

  it('stores only the token hash', () => {
    const account = createAccount(db, {
      email: 'a@example.com',
      passwordHash: 'h',
      actor: TEST_ACTOR,
    });
    const token = generateSessionToken();
    createAccountSession(db, account.id, token, { actor: TEST_ACTOR });
    const rows = db.prepare('SELECT token_hash FROM account_session').all() as Array<{
      token_hash: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe(token);
  });
});

describe('setAccountPassword (issue #364)', () => {
  it("sets the new password, ends that account's sessions only and logs it in its tenant", () => {
    const owner = createAccount(db, {
      email: 'owner@example.com',
      passwordHash: hashPassword('old-password'),
      actor: TEST_ACTOR,
    });
    const vendor = createAccount(db, {
      email: 'vendor@example.com',
      passwordHash: hashPassword('vendor-password'),
      actor: TEST_ACTOR,
      role: 'vendor',
    });
    createAccountSession(db, owner.id, 'tok-1', { actor: TEST_ACTOR });
    createAccountSession(db, owner.id, 'tok-2', { actor: TEST_ACTOR });
    createAccountSession(db, vendor.id, 'tok-v', { actor: TEST_ACTOR });

    const result = setAccountPassword(
      db,
      'owner@example.com',
      hashPassword('new-password'),
      {
        actor: TEST_ACTOR,
      },
    );

    expect(result).toEqual({ sessionsEnded: 2 });
    const stored = getAccountByEmail(db, 'owner@example.com')!.passwordHash;
    expect(verifyPassword('new-password', stored)).toBe(true);
    expect(verifyPassword('old-password', stored)).toBe(false);
    expect(getAccountBySessionToken(db, 'tok-1')).toBeNull();
    expect(getAccountBySessionToken(db, 'tok-2')).toBeNull();
    expect(getAccountBySessionToken(db, 'tok-v')?.email).toBe('vendor@example.com');

    const reset = listEvents(db, {
      subjectType: 'account',
      subjectId: String(owner.id),
    }).filter((e) => e.action === 'account.password_reset');
    expect(reset).toHaveLength(1);
    expect(JSON.parse(reset[0]!.detail as string)).toEqual({ sessions_ended: 2 });
    expect(reset[0]!.tenantId).not.toBeNull();
    expect(reset[0]!.detail as string).not.toMatch(/example\.com|password/);
    expect(verifyAudit(db).brokenAt).toBeNull();
  });

  it("works for a vendor, whose events are on no tenant's slice", () => {
    const vendor = createAccount(db, {
      email: 'vendor@example.com',
      passwordHash: hashPassword('old-password'),
      actor: TEST_ACTOR,
      role: 'vendor',
    });
    expect(
      setAccountPassword(db, 'vendor@example.com', hashPassword('new-password'), {
        actor: TEST_ACTOR,
      }),
    ).toEqual({ sessionsEnded: 0 });
    const reset = listEvents(db, {
      subjectType: 'account',
      subjectId: String(vendor.id),
    }).filter((e) => e.action === 'account.password_reset');
    expect(reset[0]!.tenantId).toBeNull();
  });

  it('writes nothing for an address no account has', () => {
    createAccount(db, {
      email: 'owner@example.com',
      passwordHash: hashPassword('old-password'),
      actor: TEST_ACTOR,
    });
    const before = verifyAudit(db).events;
    expect(
      setAccountPassword(db, 'nobody@example.com', hashPassword('new-password'), {
        actor: TEST_ACTOR,
      }),
    ).toBeNull();
    expect(verifyAudit(db).events).toBe(before);
  });
});
