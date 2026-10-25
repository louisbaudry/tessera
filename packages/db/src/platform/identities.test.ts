import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  generateSessionToken,
  generateSsoToken,
  hashPassword,
  NO_PASSWORD_HASH,
  type SsoIdentity,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { verifyAudit } from '../audit/events.js';
import { createAccount, getAccountBySessionToken, type Account } from './accounts.js';
import {
  IdentityTakenError,
  LastWayInError,
  NoSuchIdentityError,
  createSsoSession,
  findAccountByIdentity,
  linkIdentity,
  listIdentities,
  unlinkIdentity,
} from './identities.js';
import { recordFailedSsoLogin } from './audit.js';
import { openPlatformDb } from './index.js';
import {
  claimSsoCallback,
  completeSsoCallback,
  createSsoAttempt,
  redeemSsoHandoff,
  SSO_ATTEMPT_TTL_MS,
  SSO_HANDOFF_TTL_MS,
} from './sso-attempts.js';

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-identities-'));
  db = openPlatformDb(join(dir, 'platform.sqlite'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const NOW = new Date('2026-10-25T12:00:00Z');
const BINDING = 'a-browser-secret-0123456789';
const later = (ms: number) => new Date(NOW.getTime() + ms);

const identity = (subject = 'sub-1', over: Partial<SsoIdentity> = {}): SsoIdentity => ({
  provider: 'google',
  issuer: 'https://accounts.google.com',
  subject,
  directory: null,
  hostedDomain: null,
  ...over,
});

function staff(email = 'a@example.com', passwordHash = hashPassword('pw')): Account {
  return createAccount(db, { email, passwordHash, actor: TEST_ACTOR });
}

const events = (action: string) =>
  db.prepare('SELECT * FROM audit_event WHERE action = ? ORDER BY id').all(action) as {
    subject_id: string;
    detail: string | null;
    tenant_id: number | null;
  }[];

describe('linking an identity', () => {
  it('finds the account a provider identity was linked to, and nobody for another', () => {
    const a = staff();
    linkIdentity(db, a.id, identity(), { actor: TEST_ACTOR });
    expect(findAccountByIdentity(db, identity())?.id).toBe(a.id);
    expect(findAccountByIdentity(db, identity('sub-2'))).toBeNull();
  });

  it('keeps the same subject at another issuer, or provider, a different identity', () => {
    const a = staff();
    linkIdentity(db, a.id, identity(), { actor: TEST_ACTOR });
    expect(
      findAccountByIdentity(
        db,
        identity('sub-1', { issuer: 'https://login.microsoftonline.com/t/v2.0' }),
      ),
    ).toBeNull();
    expect(
      findAccountByIdentity(db, identity('sub-1', { provider: 'microsoft' })),
    ).toBeNull();
  });

  it('refuses an identity that belongs to another account, so one person never opens two', () => {
    const a = staff('a@example.com');
    const b = staff('b@example.com');
    linkIdentity(db, a.id, identity(), { actor: TEST_ACTOR });
    expect(() => linkIdentity(db, b.id, identity(), { actor: TEST_ACTOR })).toThrow(
      IdentityTakenError,
    );
    expect(findAccountByIdentity(db, identity())?.id).toBe(a.id);
  });

  it('is a no-op the second time for the same account, and logs once', () => {
    const a = staff();
    const first = linkIdentity(db, a.id, identity(), { actor: TEST_ACTOR });
    const again = linkIdentity(db, a.id, identity(), { actor: TEST_ACTOR });
    expect(again.id).toBe(first.id);
    expect(events('account.sso_linked')).toHaveLength(1);
  });

  it("logs the provider and the account, in the account's tenant, and nothing else", () => {
    const a = staff();
    linkIdentity(db, a.id, identity('secret-subject'), { actor: TEST_ACTOR });
    const [event] = events('account.sso_linked');
    expect(event?.subject_id).toBe(String(a.id));
    expect(JSON.parse(event?.detail ?? 'null')).toEqual({ provider: 'google' });
    expect(event?.tenant_id).not.toBeNull();
    // The log is hashed and never erased: no identifier from the provider may be in it.
    const all = JSON.stringify(db.prepare('SELECT * FROM audit_event').all());
    expect(all).not.toContain('secret-subject');
    expect(all).not.toContain('accounts.google.com');
  });

  it('keeps the audit chain intact', () => {
    const a = staff();
    linkIdentity(db, a.id, identity(), { actor: TEST_ACTOR });
    unlinkIdentity(db, a.id, listIdentities(db, a.id)[0]!.id, { actor: TEST_ACTOR });
    expect(verifyAudit(db).brokenAt).toBeNull();
  });

  it('lists only what the owner of the account may see: the provider and when', () => {
    const a = staff();
    linkIdentity(db, a.id, identity(), { actor: TEST_ACTOR, now: NOW });
    const [row] = listIdentities(db, a.id);
    expect(row).toEqual({
      id: expect.any(Number),
      provider: 'google',
      linkedAt: NOW.toISOString(),
      lastLoginAt: null,
    });
  });
});

describe('unlinking an identity', () => {
  it('removes it and logs the provider', () => {
    const a = staff();
    const link = linkIdentity(db, a.id, identity(), { actor: TEST_ACTOR });
    unlinkIdentity(db, a.id, link.id, { actor: TEST_ACTOR });
    expect(findAccountByIdentity(db, identity())).toBeNull();
    expect(listIdentities(db, a.id)).toEqual([]);
    expect(JSON.parse(events('account.sso_unlinked')[0]?.detail ?? 'null')).toEqual({
      provider: 'google',
    });
  });

  it("refuses another account's link as one that does not exist", () => {
    const a = staff('a@example.com');
    const b = staff('b@example.com');
    const link = linkIdentity(db, a.id, identity(), { actor: TEST_ACTOR });
    expect(() => unlinkIdentity(db, b.id, link.id, { actor: TEST_ACTOR })).toThrow(
      NoSuchIdentityError,
    );
    expect(findAccountByIdentity(db, identity())?.id).toBe(a.id);
  });

  it('refuses to leave an account with no way in', () => {
    const a = staff('a@example.com', NO_PASSWORD_HASH);
    const only = linkIdentity(db, a.id, identity(), { actor: TEST_ACTOR });
    expect(() => unlinkIdentity(db, a.id, only.id, { actor: TEST_ACTOR })).toThrow(
      LastWayInError,
    );
    expect(findAccountByIdentity(db, identity())?.id).toBe(a.id);
  });

  it('lets a password-less account drop one of two links', () => {
    const a = staff('a@example.com', NO_PASSWORD_HASH);
    const one = linkIdentity(db, a.id, identity('s1'), { actor: TEST_ACTOR });
    linkIdentity(db, a.id, identity('s2', { provider: 'microsoft' }), {
      actor: TEST_ACTOR,
    });
    unlinkIdentity(db, a.id, one.id, { actor: TEST_ACTOR });
    expect(listIdentities(db, a.id)).toHaveLength(1);
  });

  it('lets an account with a password drop its only link', () => {
    const a = staff();
    const only = linkIdentity(db, a.id, identity(), { actor: TEST_ACTOR });
    unlinkIdentity(db, a.id, only.id, { actor: TEST_ACTOR });
    expect(listIdentities(db, a.id)).toEqual([]);
  });
});

describe('a session started by a provider', () => {
  it('is an ordinary session, logged as an SSO sign-in naming the provider only', () => {
    const a = staff();
    linkIdentity(db, a.id, identity(), { actor: TEST_ACTOR });
    const token = generateSessionToken();
    createSsoSession(db, a.id, token, identity(), { actor: TEST_ACTOR, now: NOW });
    expect(getAccountBySessionToken(db, token, NOW)?.id).toBe(a.id);
    expect(events('auth.login')).toHaveLength(0);
    expect(JSON.parse(events('auth.sso_login')[0]?.detail ?? 'null')).toEqual({
      provider: 'google',
    });
  });

  it('records when the identity was last used', () => {
    const a = staff();
    linkIdentity(db, a.id, identity(), { actor: TEST_ACTOR, now: NOW });
    createSsoSession(db, a.id, generateSessionToken(), identity(), {
      actor: TEST_ACTOR,
      now: later(5000),
    });
    expect(listIdentities(db, a.id)[0]?.lastLoginAt).toBe(later(5000).toISOString());
  });

  it("is on the host's tenant when one is named, as a password login is", () => {
    const a = staff();
    linkIdentity(db, a.id, identity(), { actor: TEST_ACTOR });
    createSsoSession(db, a.id, generateSessionToken(), identity(), {
      actor: TEST_ACTOR,
      tenantId: 424242,
    });
    expect(events('auth.sso_login')[0]?.tenant_id).toBe(424242);
  });
});

describe('a sign-in attempt', () => {
  const start = (over: Partial<Parameters<typeof createSsoAttempt>[1]> = {}) => {
    const state = generateSsoToken();
    createSsoAttempt(db, {
      state,
      binding: BINDING,
      nonce: 'nonce-1',
      codeVerifier: 'verifier-1',
      provider: 'google',
      purpose: 'login',
      tenantId: null,
      accountId: null,
      now: NOW,
      ...over,
    });
    return state;
  };

  it('is found again by its state, once, with what the exchange needs', () => {
    const state = start();
    const attempt = claimSsoCallback(db, state, later(1000));
    expect(attempt).toMatchObject({
      nonce: 'nonce-1',
      codeVerifier: 'verifier-1',
      provider: 'google',
      purpose: 'login',
      tenantId: null,
      accountId: null,
    });
    // A replayed callback finds nothing: the state is single use.
    expect(claimSsoCallback(db, state, later(2000))).toBeNull();
  });

  it('is not found for a state nobody minted', () => {
    start();
    expect(claimSsoCallback(db, generateSsoToken(), NOW)).toBeNull();
  });

  it('expires', () => {
    const state = start();
    expect(claimSsoCallback(db, state, later(SSO_ATTEMPT_TTL_MS + 1))).toBeNull();
  });

  it('stores the state only as a hash', () => {
    const state = start();
    const rows = JSON.stringify(db.prepare('SELECT * FROM sso_attempt').all());
    expect(rows).not.toContain(state);
  });

  it('sweeps what has expired when the next one starts', () => {
    start();
    start({ now: later(SSO_ATTEMPT_TTL_MS * 3) });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sso_attempt').get()).toEqual({ n: 1 });
  });

  it('refuses a link attempt that names no account, and a login attempt that names one', () => {
    expect(() => start({ purpose: 'link', accountId: null })).toThrow();
    const a = staff();
    expect(() => start({ purpose: 'login', accountId: a.id })).toThrow();
  });
});

describe("the hand-off from the callback host to a tenant's host", () => {
  /** An attempt carried through the callback, as the callback host does. */
  function handedOff(
    over: Partial<Parameters<typeof createSsoAttempt>[1]> = {},
    who: SsoIdentity = identity(),
  ) {
    const state = generateSsoToken();
    createSsoAttempt(db, {
      state,
      binding: BINDING,
      nonce: 'n',
      codeVerifier: 'v',
      provider: who.provider,
      purpose: 'login',
      tenantId: 7,
      accountId: null,
      now: NOW,
      ...over,
    });
    const attempt = claimSsoCallback(db, state, NOW)!;
    const code = generateSsoToken();
    completeSsoCallback(db, attempt.id, who, code, NOW);
    return code;
  }

  it('gives the identity back once, on the tenant it was started on', () => {
    const code = handedOff();
    expect(
      redeemSsoHandoff(db, code, {
        tenantId: 7,
        purpose: 'login',
        accountId: null,
        binding: BINDING,
        now: later(1000),
      }),
    ).toEqual(identity());
    expect(
      redeemSsoHandoff(db, code, {
        tenantId: 7,
        purpose: 'login',
        accountId: null,
        binding: BINDING,
        now: later(1000),
      }),
    ).toBeNull();
  });

  it("refuses another tenant's host, and burns the code so it cannot be tried again", () => {
    const code = handedOff();
    expect(
      redeemSsoHandoff(db, code, {
        tenantId: 8,
        purpose: 'login',
        accountId: null,
        binding: BINDING,
        now: later(1000),
      }),
    ).toBeNull();
    expect(
      redeemSsoHandoff(db, code, {
        tenantId: 7,
        purpose: 'login',
        accountId: null,
        binding: BINDING,
        now: later(1000),
      }),
    ).toBeNull();
  });

  it("refuses a host that is no tenant's for a code started on one, and the reverse", () => {
    const none = handedOff({ tenantId: null });
    expect(
      redeemSsoHandoff(db, none, {
        tenantId: 7,
        purpose: 'login',
        accountId: null,
        binding: BINDING,
        now: NOW,
      }),
    ).toBeNull();
    const some = handedOff({ tenantId: 7 });
    expect(
      redeemSsoHandoff(db, some, {
        tenantId: null,
        purpose: 'login',
        accountId: null,
        binding: BINDING,
        now: NOW,
      }),
    ).toBeNull();
    const ok = handedOff({ tenantId: null });
    expect(
      redeemSsoHandoff(db, ok, {
        tenantId: null,
        purpose: 'login',
        accountId: null,
        binding: BINDING,
        now: NOW,
      }),
    ).toEqual(identity());
  });

  it('refuses a browser that did not start the attempt, and burns the code', () => {
    const code = handedOff();
    const redeem = (binding: string) =>
      redeemSsoHandoff(db, code, {
        tenantId: 7,
        purpose: 'login',
        accountId: null,
        binding,
        now: NOW,
      });
    // A victim's browser, tricked into presenting an attacker's code, has no such secret.
    expect(redeem('some-other-browser-secret-999')).toBeNull();
    expect(redeem(BINDING)).toBeNull();
  });

  it('stores the browser secret only as a hash', () => {
    handedOff();
    expect(JSON.stringify(db.prepare('SELECT * FROM sso_attempt').all())).not.toContain(
      BINDING,
    );
  });

  it('expires within a minute', () => {
    const code = handedOff();
    expect(
      redeemSsoHandoff(db, code, {
        tenantId: 7,
        purpose: 'login',
        accountId: null,
        binding: BINDING,
        now: later(SSO_HANDOFF_TTL_MS + 1),
      }),
    ).toBeNull();
  });

  it('is not redeemable for the other purpose', () => {
    const code = handedOff();
    expect(
      redeemSsoHandoff(db, code, {
        tenantId: 7,
        purpose: 'link',
        accountId: 1,
        binding: BINDING,
        now: NOW,
      }),
    ).toBeNull();
  });

  it("hands a link only to the account that started it, so a victim's browser cannot complete another's", () => {
    const a = staff('a@example.com');
    const b = staff('b@example.com');
    const code = handedOff({ purpose: 'link', accountId: a.id });
    expect(
      redeemSsoHandoff(db, code, {
        tenantId: 7,
        purpose: 'link',
        accountId: b.id,
        binding: BINDING,
        now: NOW,
      }),
    ).toBeNull();
    const again = handedOff({ purpose: 'link', accountId: a.id });
    expect(
      redeemSsoHandoff(db, again, {
        tenantId: 7,
        purpose: 'link',
        accountId: a.id,
        binding: BINDING,
        now: NOW,
      }),
    ).toEqual(identity());
  });

  it('cannot be redeemed before the callback has verified a token', () => {
    const state = generateSsoToken();
    createSsoAttempt(db, {
      state,
      binding: BINDING,
      nonce: 'n',
      codeVerifier: 'v',
      provider: 'google',
      purpose: 'login',
      tenantId: 7,
      accountId: null,
      now: NOW,
    });
    // Guessing the state is not a hand-off code, and no hand-off has been issued.
    expect(
      redeemSsoHandoff(db, state, {
        tenantId: 7,
        purpose: 'login',
        accountId: null,
        binding: BINDING,
        now: NOW,
      }),
    ).toBeNull();
  });

  it('stores the code only as a hash', () => {
    const code = handedOff();
    expect(JSON.stringify(db.prepare('SELECT * FROM sso_attempt').all())).not.toContain(
      code,
    );
  });
});

describe('a refused sign-in', () => {
  it("is logged with the provider and the reason, about no tenant unless one's host was used", () => {
    recordFailedSsoLogin(db, {
      actor: TEST_ACTOR,
      provider: 'microsoft',
      reason: 'unknown_identity',
    });
    recordFailedSsoLogin(db, {
      actor: TEST_ACTOR,
      provider: null,
      reason: 'handoff_refused',
      tenantId: 12,
    });
    const rows = events('auth.sso_login_failed');
    expect(rows.map((r) => JSON.parse(r.detail ?? 'null'))).toEqual([
      { provider: 'microsoft', reason: 'unknown_identity' },
      { provider: null, reason: 'handoff_refused' },
    ]);
    expect(rows.map((r) => r.tenant_id)).toEqual([null, 12]);
    expect(verifyAudit(db).brokenAt).toBeNull();
  });
});
