/** `roster_membership` (backlog #52a): which owners' rosters an account is on. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { createAccount, type Account } from './accounts.js';
import { openPlatformDb } from './index.js';
import { addRosterMembership, listRosterOwners } from './membership.js';

let dir: string;
let db: Database.Database;
let alice: Account;
let carol: Account;
let bob: Account;

const make = (email: string, role?: 'vendor') =>
  createAccount(db, {
    email,
    passwordHash: 'h',
    actor: TEST_ACTOR,
    ...(role ? { role } : {}),
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-membership-'));
  db = openPlatformDb(join(dir, 'platform.sqlite'));
  alice = make('alice@example.com');
  carol = make('carol@example.com');
  bob = make('bob@example.com', 'vendor');
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('roster membership', () => {
  it('lists the owners an account is on the roster of, by owner id', () => {
    addRosterMembership(db, { ownerId: carol.id, accountId: bob.id });
    addRosterMembership(db, { ownerId: alice.id, accountId: bob.id });
    expect(listRosterOwners(db, bob.id)).toEqual([alice.id, carol.id]);
    expect(listRosterOwners(db, alice.id)).toEqual([]);
  });

  it('is idempotent, and says whether it added a row', () => {
    expect(addRosterMembership(db, { ownerId: alice.id, accountId: bob.id })).toBe(true);
    expect(addRosterMembership(db, { ownerId: alice.id, accountId: bob.id })).toBe(false);
    expect(listRosterOwners(db, bob.id)).toEqual([alice.id]);
  });

  it('refuses an owner on their own roster, and an account that does not exist', () => {
    expect(() =>
      addRosterMembership(db, { ownerId: alice.id, accountId: alice.id }),
    ).toThrow();
    expect(() =>
      addRosterMembership(db, { ownerId: alice.id, accountId: 9999 }),
    ).toThrow();
  });
});
