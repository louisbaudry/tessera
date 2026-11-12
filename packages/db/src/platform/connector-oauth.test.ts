/**
 * Sign-in from a chat host (backlog #381, `planning/chat-connector-spec.md` §6b): a client
 * registers, a code is exchanged once with its PKCE verifier, refresh tokens rotate, and a
 * spent credential presented again ends the connection.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateSessionToken } from '@cat-tool/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, setAccountPassword, type Account } from './accounts.js';
import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents, verifyAudit } from '../audit/events.js';
import type { OauthClientError } from './connector-oauth.js';
import {
  createOauthCode,
  exchangeOauthCode,
  getOauthClient,
  listConnections,
  MAX_CLIENT_REGISTRATIONS_PER_HOUR,
  MAX_CONNECTIONS,
  OAUTH_ACCESS_TTL_MS,
  OAUTH_CODE_TTL_MS,
  OAUTH_REFRESH_TTL_MS,
  refreshOauthConnection,
  registerOauthClient,
  revokeConnection,
  UNUSED_CLIENT_TTL_MS,
  type OauthClient,
} from './connector-oauth.js';
import {
  ConnectorTokenError,
  createConnectorToken,
  listConnectorTokens,
  resolveConnectorToken,
} from './connector-tokens.js';
import { openPlatformDb } from './index.js';
import { getTenantForAccount, removeTenantStaff } from './tenants.js';

const REDIRECT = 'https://chat.example/callback';
const VERIFIER = 'v'.repeat(43);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const T0 = new Date('2026-11-11T10:00:00.000Z');
const later = (ms: number): Date => new Date(T0.getTime() + ms);

let dir: string;
let db: Database.Database;
let vendor: Account;
let admin: Account;
let tenantId: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-oauth-'));
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
  tenantId = getTenantForAccount(db, admin.id)!.tenant.id;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function register(
  over: {
    name?: unknown;
    redirectUris?: unknown;
    tenantId?: number | null;
    now?: Date;
  } = {},
): OauthClient {
  return registerOauthClient(db, {
    clientId: generateSessionToken(),
    name: 'name' in over ? over.name : 'Chat host',
    redirectUris: 'redirectUris' in over ? over.redirectUris : [REDIRECT],
    tenantId: 'tenantId' in over ? (over.tenantId ?? null) : null,
    now: over.now ?? T0,
  });
}

/** A code for `account`, stored; returns the code. */
function consent(client: OauthClient, account: Account = admin, now: Date = T0): string {
  const code = generateSessionToken();
  createOauthCode(db, {
    code,
    client,
    accountId: account.id,
    redirectUri: REDIRECT,
    codeChallenge: CHALLENGE,
    now,
  });
  return code;
}

function exchange(
  client: OauthClient,
  code: string,
  over: {
    verifier?: unknown;
    redirectUri?: unknown;
    clientId?: string;
    hostTenantId?: number | null;
    now?: Date;
  } = {},
): { access: string; refresh: string } | null {
  const access = generateSessionToken();
  const refresh = generateSessionToken();
  const issued = exchangeOauthCode(db, {
    code,
    clientId: over.clientId ?? client.clientId,
    hostTenantId: 'hostTenantId' in over ? (over.hostTenantId ?? null) : client.tenantId,
    redirectUri: 'redirectUri' in over ? over.redirectUri : REDIRECT,
    verifier: 'verifier' in over ? over.verifier : VERIFIER,
    accessToken: access,
    refreshToken: refresh,
    now: over.now ?? T0,
  });
  return issued ? { access, refresh } : null;
}

function refresh(
  client: OauthClient,
  token: string,
  over: { clientId?: string; now?: Date } = {},
): { access: string; refresh: string } | null {
  const access = generateSessionToken();
  const next = generateSessionToken();
  const issued = refreshOauthConnection(db, {
    refreshToken: token,
    clientId: over.clientId ?? client.clientId,
    hostTenantId: client.tenantId,
    accessToken: access,
    newRefreshToken: next,
    now: over.now ?? T0,
  });
  return issued ? { access, refresh: next } : null;
}

const actions = (): string[] =>
  listEvents(db, { subjectType: 'account' })
    .map((e) => e.action)
    .filter((a) => a.startsWith('connector.'));

describe('registerOauthClient', () => {
  it('stores a client and finds it on its own host only', () => {
    const client = register({ tenantId });
    expect(getOauthClient(db, client.clientId, tenantId)).toEqual(client);
    expect(getOauthClient(db, client.clientId, null)).toBeNull();
    expect(getOauthClient(db, 'unknown', tenantId)).toBeNull();
    const open = register();
    expect(getOauthClient(db, open.clientId, null)?.id).toBe(open.id);
    expect(getOauthClient(db, open.clientId, tenantId)).toBeNull();
  });

  it.each([
    [{ name: '' }, 'bad_name'],
    [{ name: 'x'.repeat(81) }, 'bad_name'],
    [{ name: 'a\u0007b' }, 'bad_name'],
    [{ name: 7 }, 'bad_name'],
    [{ redirectUris: [] }, 'bad_redirect'],
    [{ redirectUris: 'https://chat.example/cb' }, 'bad_redirect'],
    [{ redirectUris: ['http://chat.example/cb'] }, 'bad_redirect'],
    [
      { redirectUris: Array.from({ length: 6 }, (_, i) => `https://chat.example/${i}`) },
      'bad_redirect',
    ],
  ])('refuses %j', (over, problem) => {
    expect(() => register(over)).toThrowError(
      expect.objectContaining({ problem }) as OauthClientError,
    );
  });

  it('refuses the registration after the hour’s cap, and accepts again an hour on', () => {
    for (let i = 0; i < MAX_CLIENT_REGISTRATIONS_PER_HOUR; i += 1) register();
    expect(() => register()).toThrowError(
      expect.objectContaining({ problem: 'too_many' }) as OauthClientError,
    );
    expect(register({ now: later(60 * 60 * 1000 + 1) }).id).toBeGreaterThan(0);
  });

  it('deletes a client nobody connected after thirty days, and keeps a connected one', () => {
    const unused = register();
    const pending = register();
    consent(pending);
    const used = register();
    expect(exchange(used, consent(used))).not.toBeNull();
    register({ now: later(UNUSED_CLIENT_TTL_MS + 1) });
    expect(getOauthClient(db, unused.clientId, null)).toBeNull();
    // A code alone is not a connection: the client goes, and its code with it.
    expect(getOauthClient(db, pending.clientId, null)).toBeNull();
    expect(getOauthClient(db, used.clientId, null)).not.toBeNull();
  });
});

describe('createOauthCode', () => {
  it('refuses a vendor, and staff of another tenant than the client’s host', () => {
    expect(() => consent(register(), vendor)).toThrowError(ConnectorTokenError);
    const other = createAccount(db, {
      email: 'b@example.com',
      passwordHash: 'h',
      actor: TEST_ACTOR,
    });
    expect(() => consent(register({ tenantId }), other)).toThrowError(
      ConnectorTokenError,
    );
  });
});

describe('exchangeOauthCode', () => {
  it('makes a connection whose access token opens the connector, and logs it', () => {
    const client = register({ tenantId });
    const tokens = exchange(client, consent(client))!;
    const who = resolveConnectorToken(db, tokens.access, T0);
    expect(who?.account.id).toBe(admin.id);
    expect(who?.membership.tenant.id).toBe(tenantId);
    // An hour, and not a second more.
    expect(
      resolveConnectorToken(db, tokens.access, later(OAUTH_ACCESS_TTL_MS - 1)),
    ).not.toBeNull();
    expect(
      resolveConnectorToken(db, tokens.access, later(OAUTH_ACCESS_TTL_MS)),
    ).toBeNull();
    expect(listConnections(db, admin.id, T0)).toEqual([
      expect.objectContaining({ name: 'Chat host', createdAt: T0.toISOString() }),
    ]);
    // A connection's access token is not one of the person's hand-made tokens.
    expect(listConnectorTokens(db, admin.id, T0)).toEqual([]);
    const event = listEvents(db, { subjectType: 'account' }).find(
      (e) => e.action === 'connector.connected',
    )!;
    expect(event.actor).toBe(`account:${admin.id}`);
    expect(event.tenantId).toBe(tenantId);
    expect(JSON.parse(event.detail!)).toEqual({
      connection_id: listConnections(db, admin.id, T0)[0]!.id,
      client: client.id,
    });
    // Nothing a stranger typed is in the log.
    expect(event.detail).not.toContain('Chat host');
    expect(verifyAudit(db).brokenAt).toBeNull();
  });

  it.each([
    ['a wrong verifier', { verifier: 'w'.repeat(43) }],
    ['no verifier', { verifier: undefined }],
    ['the challenge as the verifier', { verifier: CHALLENGE }],
    ['another redirect address', { redirectUri: 'https://chat.example/other' }],
    ['another client', { clientId: 'someone-else' }],
    ['a code past its two minutes', { now: later(OAUTH_CODE_TTL_MS) }],
  ])('refuses %s, and the code is spent by the try', (_what, over) => {
    const client = register();
    const code = consent(client);
    expect(exchange(client, code, over)).toBeNull();
    // The right exchange after a wrong one is refused too: a code is not a guessing game.
    expect(exchange(client, code)).toBeNull();
    expect(listConnections(db, admin.id, T0)).toEqual([]);
  });

  it('refuses an unknown code', () => {
    expect(exchange(register(), generateSessionToken())).toBeNull();
  });

  it('ends the connection when its code is presented a second time', () => {
    const client = register();
    const code = consent(client);
    const tokens = exchange(client, code)!;
    expect(exchange(client, code)).toBeNull();
    expect(resolveConnectorToken(db, tokens.access, T0)).toBeNull();
    expect(refresh(client, tokens.refresh)).toBeNull();
    expect(listConnections(db, admin.id, T0)).toEqual([]);
    const ended = listEvents(db, { subjectType: 'account' }).find(
      (e) => e.action === 'connector.disconnected',
    )!;
    expect(ended.actor).toBe('system:connector-oauth');
    expect(JSON.parse(ended.detail!)).toMatchObject({ reason: 'reuse' });
  });

  it('refuses someone removed from the tenant between consent and exchange', () => {
    const colleague = createAccount(db, {
      email: 'colleague@example.com',
      passwordHash: 'h',
      actor: TEST_ACTOR,
      joinTenant: { tenantId, role: 'pm' },
    });
    const client = register();
    const code = consent(client, colleague);
    removeTenantStaff(db, { tenantId, accountId: colleague.id, actor: TEST_ACTOR });
    expect(exchange(client, code)).toBeNull();
  });

  it('replaces the person’s earlier connection from the same client', () => {
    const client = register();
    const first = exchange(client, consent(client))!;
    const second = exchange(client, consent(client))!;
    expect(resolveConnectorToken(db, first.access, T0)).toBeNull();
    expect(resolveConnectorToken(db, second.access, T0)).not.toBeNull();
    expect(listConnections(db, admin.id, T0)).toHaveLength(1);
    expect(actions()).toEqual([
      'connector.connected',
      'connector.disconnected',
      'connector.connected',
    ]);
  });

  it('ends the oldest connection past the limit', () => {
    const first = register();
    const oldest = exchange(first, consent(first))!;
    for (let i = 1; i < MAX_CONNECTIONS; i += 1) {
      const c = register();
      exchange(c, consent(c));
    }
    expect(listConnections(db, admin.id, T0)).toHaveLength(MAX_CONNECTIONS);
    expect(resolveConnectorToken(db, oldest.access, T0)).not.toBeNull();
    const extra = register();
    exchange(extra, consent(extra));
    expect(listConnections(db, admin.id, T0)).toHaveLength(MAX_CONNECTIONS);
    expect(resolveConnectorToken(db, oldest.access, T0)).toBeNull();
  });
});

describe('refreshOauthConnection', () => {
  it('rotates: a new pair, the old access token ended, the connection kept alive', () => {
    const client = register();
    const first = exchange(client, consent(client))!;
    const at = later(30 * 60 * 1000);
    const second = refresh(client, first.refresh, { now: at })!;
    expect(resolveConnectorToken(db, second.access, at)).not.toBeNull();
    expect(resolveConnectorToken(db, first.access, at)).toBeNull();
    expect(listConnections(db, admin.id, at)[0]!.lastUsedAt).toBe(at.toISOString());
    // The refresh token's own ninety days run from each rotation.
    const far = later(OAUTH_REFRESH_TTL_MS + 1);
    expect(listConnections(db, admin.id, far)).toHaveLength(1);
    expect(refresh(client, second.refresh, { now: far })).not.toBeNull();
    // No event per refresh: only the connection was logged.
    expect(actions()).toEqual(['connector.connected']);
  });

  it('ends the connection when a spent refresh token is presented again', () => {
    const client = register();
    const first = exchange(client, consent(client))!;
    const second = refresh(client, first.refresh)!;
    expect(refresh(client, first.refresh)).toBeNull();
    expect(resolveConnectorToken(db, second.access, T0)).toBeNull();
    expect(refresh(client, second.refresh)).toBeNull();
    expect(listConnections(db, admin.id, T0)).toEqual([]);
  });

  it('refuses another client without spending the token, a lapsed token and an unknown one', () => {
    const client = register();
    const first = exchange(client, consent(client))!;
    expect(refresh(client, first.refresh, { clientId: 'someone-else' })).toBeNull();
    expect(refresh(client, generateSessionToken())).toBeNull();
    expect(
      refresh(client, first.refresh, { now: later(OAUTH_REFRESH_TTL_MS) }),
    ).toBeNull();
    expect(refresh(client, first.refresh)).not.toBeNull();
  });

  it('refuses someone removed from the tenant, with no second write', () => {
    const colleague = createAccount(db, {
      email: 'colleague@example.com',
      passwordHash: 'h',
      actor: TEST_ACTOR,
      joinTenant: { tenantId, role: 'pm' },
    });
    const client = register();
    const tokens = exchange(client, consent(client, colleague))!;
    removeTenantStaff(db, { tenantId, accountId: colleague.id, actor: TEST_ACTOR });
    expect(resolveConnectorToken(db, tokens.access, T0)).toBeNull();
    expect(refresh(client, tokens.refresh)).toBeNull();
  });
});

describe('a code or refresh token at another tenant\u2019s address', () => {
  it('is refused, and the right address still works', () => {
    const other = createAccount(db, {
      email: 'b@example.com',
      passwordHash: 'h',
      actor: TEST_ACTOR,
    });
    const otherTenant = getTenantForAccount(db, other.id)!.tenant.id;
    const client = register({ tenantId });
    const at = (hostTenantId: number | null, code: string) =>
      exchangeOauthCode(db, {
        code,
        clientId: client.clientId,
        hostTenantId,
        redirectUri: REDIRECT,
        verifier: VERIFIER,
        accessToken: generateSessionToken(),
        refreshToken: generateSessionToken(),
        now: T0,
      });
    expect(at(otherTenant, consent(client))).toBeNull();
    expect(at(null, consent(client))).toBeNull();
    expect(at(tenantId, consent(client))).not.toBeNull();

    const tokens = exchange(client, consent(client), { hostTenantId: tenantId })!;
    const refreshAt = (hostTenantId: number | null) =>
      refreshOauthConnection(db, {
        refreshToken: tokens.refresh,
        clientId: client.clientId,
        hostTenantId,
        accessToken: generateSessionToken(),
        newRefreshToken: generateSessionToken(),
        now: T0,
      });
    expect(refreshAt(otherTenant)).toBeNull();
    // Refused without being spent: the client's own address still rotates it.
    expect(refreshAt(tenantId)).not.toBeNull();
  });
});

describe('ending a connection', () => {
  it('a password reset spends a code that was waiting to be exchanged', () => {
    const client = register();
    const code = consent(client);
    setAccountPassword(db, admin.email, 'new-hash', { actor: TEST_ACTOR });
    expect(exchange(client, code)).toBeNull();
    expect(listConnections(db, admin.id, T0)).toEqual([]);
  });

  it('a person ends their own, once, and nobody else’s', () => {
    const colleague = createAccount(db, {
      email: 'colleague@example.com',
      passwordHash: 'h',
      actor: TEST_ACTOR,
      joinTenant: { tenantId, role: 'pm' },
    });
    const client = register();
    const tokens = exchange(client, consent(client))!;
    const id = listConnections(db, admin.id, T0)[0]!.id;
    expect(revokeConnection(db, { accountId: colleague.id, id, actor: TEST_ACTOR })).toBe(
      false,
    );
    expect(revokeConnection(db, { accountId: admin.id, id, actor: TEST_ACTOR })).toBe(
      true,
    );
    expect(revokeConnection(db, { accountId: admin.id, id, actor: TEST_ACTOR })).toBe(
      false,
    );
    expect(resolveConnectorToken(db, tokens.access, T0)).toBeNull();
    expect(refresh(client, tokens.refresh)).toBeNull();
    expect(actions()).toEqual(['connector.connected', 'connector.disconnected']);
  });

  it('a password reset ends every connection and counts them apart from hand-made tokens', () => {
    const client = register();
    const tokens = exchange(client, consent(client))!;
    createConnectorToken(db, {
      accountId: admin.id,
      token: generateSessionToken(),
      label: 'by hand',
      actor: TEST_ACTOR,
    });
    setAccountPassword(db, admin.email, 'new-hash', { actor: TEST_ACTOR });
    expect(resolveConnectorToken(db, tokens.access, T0)).toBeNull();
    expect(refresh(client, tokens.refresh)).toBeNull();
    const reset = listEvents(db, { subjectType: 'account' }).find(
      (e) => e.action === 'account.password_reset',
    )!;
    expect(JSON.parse(reset.detail!)).toMatchObject({
      connector_tokens_revoked: 1,
      connections_ended: 1,
    });
    expect(verifyAudit(db).brokenAt).toBeNull();
  });
});
