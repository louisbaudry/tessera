/**
 * Connector tokens (backlog #378, `planning/chat-connector-spec.md` D4): made for staff only,
 * stored as a hash, alive only while the person is still staff of the token's tenant, and
 * logged without the label.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateSessionToken, hashSessionToken } from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, setAccountPassword, type Account } from './accounts.js';
import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents, verifyAudit } from '../audit/events.js';
import {
  CONNECTOR_TOKEN_TTL_MS,
  ConnectorTokenError,
  createConnectorToken,
  listConnectorTokens,
  MAX_CONNECTOR_TOKENS,
  resolveConnectorToken,
  revokeConnectorToken,
} from './connector-tokens.js';
import { openPlatformDb } from './index.js';
import { getTenantForAccount, removeTenantStaff } from './tenants.js';

let dir: string;
let db: Database.Database;
let vendor: Account;
let admin: Account;
let colleague: Account;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-connector-'));
  db = openPlatformDb(join(dir, 'platform.sqlite'));
  // A vendor first, so no tenant's id equals its founder's account id (CLAUDE.md, Tenants).
  vendor = createAccount(db, {
    email: 'vendor@example.com',
    passwordHash: 'h',
    role: 'vendor',
    actor: TEST_ACTOR,
  });
  admin = createAccount(db, {
    email: 'admin@example.com',
    passwordHash: 'h',
    actor: TEST_ACTOR,
  });
  colleague = createAccount(db, {
    email: 'colleague@example.com',
    passwordHash: 'h',
    actor: TEST_ACTOR,
    joinTenant: { tenantId: getTenantForAccount(db, admin.id)!.tenant.id, role: 'pm' },
  });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const make = (account: Account, label: unknown = 'Laptop', now?: Date) => {
  const token = generateSessionToken();
  const made = createConnectorToken(db, {
    accountId: account.id,
    token,
    label,
    actor: TEST_ACTOR,
    ...(now ? { now } : {}),
  });
  return { token, made };
};

describe('creating a connector token', () => {
  it('resolves to the person and the tenant they are staff of', () => {
    const { token, made } = make(admin, '  Laptop  ');
    expect(made.label).toBe('Laptop');
    const who = resolveConnectorToken(db, token);
    expect(who?.account.id).toBe(admin.id);
    expect(who?.membership.tenant.id).toBe(getTenantForAccount(db, admin.id)!.tenant.id);
    expect(resolveConnectorToken(db, generateSessionToken())).toBeNull();
  });

  it('stores only the hash of the token', () => {
    const { token } = make(admin);
    const rows = db.prepare('SELECT token_hash FROM connector_token').all() as Array<{
      token_hash: string;
    }>;
    expect(rows).toEqual([{ token_hash: hashSessionToken(token) }]);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('refuses a vendor, who is staff of no tenant', () => {
    expect(() => make(vendor)).toThrow(ConnectorTokenError);
    try {
      make(vendor);
    } catch (error) {
      expect((error as ConnectorTokenError).problem).toBe('not_staff');
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM connector_token').get()).toEqual({
      n: 0,
    });
  });

  it.each([[''], ['   '], ['x'.repeat(81)], ['two\nlines'], [42], [null]])(
    'refuses the label %j',
    (label) => {
      try {
        make(admin, label);
        expect.unreachable('the label was accepted');
      } catch (error) {
        expect((error as ConnectorTokenError).problem).toBe('bad_label');
      }
    },
  );

  it('refuses one more than the limit, and allows it again once one is revoked', () => {
    const made = Array.from({ length: MAX_CONNECTOR_TOKENS }, () => make(admin).made);
    try {
      make(admin);
      expect.unreachable('an eleventh token was made');
    } catch (error) {
      expect((error as ConnectorTokenError).problem).toBe('too_many');
    }
    expect(
      revokeConnectorToken(db, {
        accountId: admin.id,
        id: made[0]!.id,
        actor: TEST_ACTOR,
      }),
    ).toBe(true);
    expect(() => make(admin)).not.toThrow();
  });
});

describe('a connector token ends', () => {
  it('after its lifetime, to the millisecond', () => {
    const issued = new Date('2026-01-01T00:00:00Z');
    const { token } = make(admin, 'Laptop', issued);
    const justBefore = new Date(issued.getTime() + CONNECTOR_TOKEN_TTL_MS - 1);
    const justAfter = new Date(issued.getTime() + CONNECTOR_TOKEN_TTL_MS);
    expect(resolveConnectorToken(db, token, justBefore)).not.toBeNull();
    expect(resolveConnectorToken(db, token, justAfter)).toBeNull();
    expect(listConnectorTokens(db, admin.id, justBefore)).toHaveLength(1);
    expect(listConnectorTokens(db, admin.id, justAfter)).toHaveLength(0);
  });

  it('when its owner revokes it, and only its owner can', () => {
    const { token, made } = make(admin);
    // Someone else's id, an unknown id: the same false.
    expect(
      revokeConnectorToken(db, {
        accountId: colleague.id,
        id: made.id,
        actor: TEST_ACTOR,
      }),
    ).toBe(false);
    expect(
      revokeConnectorToken(db, { accountId: admin.id, id: 999, actor: TEST_ACTOR }),
    ).toBe(false);
    expect(resolveConnectorToken(db, token)).not.toBeNull();

    expect(
      revokeConnectorToken(db, { accountId: admin.id, id: made.id, actor: TEST_ACTOR }),
    ).toBe(true);
    expect(resolveConnectorToken(db, token)).toBeNull();
    expect(listConnectorTokens(db, admin.id)).toEqual([]);
    // Already revoked: false again, and no second event.
    expect(
      revokeConnectorToken(db, { accountId: admin.id, id: made.id, actor: TEST_ACTOR }),
    ).toBe(false);
    expect(
      listEvents(db, { subjectType: 'account' }).filter(
        (e) => e.action === 'connector.token_revoked',
      ),
    ).toHaveLength(1);
  });

  it('when its person is removed from the tenant, with no write to the token', () => {
    const { token } = make(colleague);
    expect(resolveConnectorToken(db, token)).not.toBeNull();
    removeTenantStaff(db, {
      tenantId: getTenantForAccount(db, admin.id)!.tenant.id,
      accountId: colleague.id,
      actor: TEST_ACTOR,
    });
    expect(resolveConnectorToken(db, token)).toBeNull();
  });

  it('when an operator resets the password, and the reset says how many', () => {
    const first = make(admin);
    const second = make(admin);
    const other = make(colleague);
    setAccountPassword(db, 'admin@example.com', 'new-hash', { actor: TEST_ACTOR });
    expect(resolveConnectorToken(db, first.token)).toBeNull();
    expect(resolveConnectorToken(db, second.token)).toBeNull();
    expect(resolveConnectorToken(db, other.token)).not.toBeNull();
    const reset = listEvents(db, { subjectType: 'account' }).filter(
      (e) => e.action === 'account.password_reset',
    );
    expect(reset.map((e) => JSON.parse(e.detail ?? 'null'))).toEqual([
      { sessions_ended: 0, connector_tokens_revoked: 2 },
    ]);
  });
});

describe('the log', () => {
  it('names the token by id in the tenant’s slice, never by label or token', () => {
    const { token, made } = make(admin, 'A label nobody should log');
    revokeConnectorToken(db, { accountId: admin.id, id: made.id, actor: TEST_ACTOR });
    const tenantId = getTenantForAccount(db, admin.id)!.tenant.id;
    const events = listEvents(db, { subjectType: 'account' }).filter((e) =>
      e.action.startsWith('connector.'),
    );
    expect(
      events.map((e) => [
        e.action,
        e.tenantId,
        e.subjectId,
        JSON.parse(e.detail ?? 'null'),
      ]),
    ).toEqual([
      [
        'connector.token_created',
        tenantId,
        String(admin.id),
        { token_id: made.id, expires_at: made.expiresAt },
      ],
      ['connector.token_revoked', tenantId, String(admin.id), { token_id: made.id }],
    ]);
    const logged = JSON.stringify(listEvents(db, { subjectType: 'account' }));
    expect(logged).not.toContain('nobody should log');
    expect(logged).not.toContain(token);
    expect(verifyAudit(db).brokenAt).toBeNull();
  });
});
