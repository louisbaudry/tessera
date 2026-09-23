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
    });
    const b = createAccount(db, {
      email: 'b@example.com',
      passwordHash: hashPassword('y'),
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
    createAccount(db, { email: 'a@example.com', passwordHash: 'h' });
    expect(() =>
      createAccount(db, { email: 'a@example.com', passwordHash: 'h' }),
    ).toThrow(/UNIQUE/);
  });
});

describe('sessions', () => {
  it('finds the account by its live token and forgets it on logout', () => {
    const account = createAccount(db, { email: 'a@example.com', passwordHash: 'h' });
    const token = generateSessionToken();
    const { expiresAt } = createAccountSession(db, account.id, token);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(getAccountBySessionToken(db, token)?.id).toBe(account.id);
    expect(getAccountBySessionToken(db, generateSessionToken())).toBeNull();

    deleteAccountSession(db, token);
    expect(getAccountBySessionToken(db, token)).toBeNull();
  });

  it('expires after the shared TTL', () => {
    const account = createAccount(db, { email: 'a@example.com', passwordHash: 'h' });
    const token = generateSessionToken();
    const issued = new Date('2026-01-01T00:00:00Z');
    createAccountSession(db, account.id, token, issued);
    const justBefore = new Date(issued.getTime() + SESSION_TTL_MS - 1);
    const justAfter = new Date(issued.getTime() + SESSION_TTL_MS);
    expect(getAccountBySessionToken(db, token, justBefore)).not.toBeNull();
    expect(getAccountBySessionToken(db, token, justAfter)).toBeNull();
  });

  it('stores only the token hash', () => {
    const account = createAccount(db, { email: 'a@example.com', passwordHash: 'h' });
    const token = generateSessionToken();
    createAccountSession(db, account.id, token);
    const rows = db.prepare('SELECT token_hash FROM account_session').all() as Array<{
      token_hash: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe(token);
  });
});
