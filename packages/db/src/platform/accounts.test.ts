import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateSessionToken, hashPassword, SESSION_TTL_MS } from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createAccount,
  createAccountSession,
  deleteAccountSession,
  getAccountByEmail,
  getAccountBySessionToken,
  listAccounts,
} from './accounts.js';
import { TEST_ACTOR } from '../audit/actor.fixture.js';
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
