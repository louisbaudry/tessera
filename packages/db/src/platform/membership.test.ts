/** `roster_membership` (backlog #52a): which tenants' rosters an account is on. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { createAccount, type Account } from './accounts.js';
import { openPlatformDb } from './index.js';
import { getTenantForAccount } from './tenants.js';
import { addRosterMembership, listRosterTenants } from './membership.js';

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

/** The tenant an account is staff of; its id is not the account's. */
const tenantOf = (account: Account): number =>
  getTenantForAccount(db, account.id)!.tenant.id;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-membership-'));
  db = openPlatformDb(join(dir, 'platform.sqlite'));
  // the vendor first, so no tenant's id equals its founder's account id
  bob = make('bob@example.com', 'vendor');
  alice = make('alice@example.com');
  carol = make('carol@example.com');
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('roster membership', () => {
  it('lists the tenants an account is on the roster of, by tenant id', () => {
    addRosterMembership(db, { tenantId: tenantOf(carol), accountId: bob.id });
    addRosterMembership(db, { tenantId: tenantOf(alice), accountId: bob.id });
    expect(listRosterTenants(db, bob.id)).toEqual([tenantOf(alice), tenantOf(carol)]);
    expect(listRosterTenants(db, alice.id)).toEqual([]);
  });

  it('is idempotent, and says whether it added a row', () => {
    expect(
      addRosterMembership(db, { tenantId: tenantOf(alice), accountId: bob.id }),
    ).toBe(true);
    expect(
      addRosterMembership(db, { tenantId: tenantOf(alice), accountId: bob.id }),
    ).toBe(false);
    expect(listRosterTenants(db, bob.id)).toEqual([tenantOf(alice)]);
  });

  it('refuses staff on their own tenant’s roster, and an account that does not exist', () => {
    expect(() =>
      addRosterMembership(db, { tenantId: tenantOf(alice), accountId: alice.id }),
    ).toThrow(/staff of a tenant are not on its roster/);
    expect(() =>
      addRosterMembership(db, { tenantId: tenantOf(alice), accountId: 9999 }),
    ).toThrow();
  });
});
