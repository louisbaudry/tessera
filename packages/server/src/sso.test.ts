/**
 * Sign in with Microsoft 365 or Google (backlog #214, `planning/sso-spec.md` §7), through a
 * provider that never leaves the process (`sso.fixture.ts`): the flow end to end on a tenant's
 * host and the neutral callback host, and every refusal the spec lists.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  hashPassword,
  NO_PASSWORD_HASH,
  type AuditActor,
  type SsoProvider,
} from '@cat-tool/core';
import {
  addRosterMembership,
  addVendor,
  createAccount,
  getTenantForAccount,
  linkIdentity,
  listAccounts,
  openPlatformDb,
  setTenantSlug,
  type Account,
  type Tenant,
} from '@cat-tool/db';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';
import { openOrCreateRoster } from './roster.js';
import { CLIENT_IDS, CLIENT_SECRETS, DIRECTORY, FakeProvider } from './sso.fixture.js';

const SETUP: AuditActor = { actor: { kind: 'system', name: 'test-setup' }, label: null };
const BASE = 'platform.localhost';
const AUTH_HOST = `auth.${BASE}`;
const HOST_A = `alpha.${BASE}`;
const HOST_B = `beta.${BASE}`;
const ORIGIN = `http://${AUTH_HOST}`;
const CALLBACK = '/api/login/sso/callback';
const BINDING = 'a-browser-secret-0123456789';
const REFUSED = { error: 'sign-in failed' };

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;
let fake: FakeProvider;
let clock: Date;
let alice: Account; // admin of tenant A, with a password
let pam: Account; // a pm of tenant A with no password at all
let carol: Account; // admin of tenant B
let erin: Account; // a vendor on both rosters
let dave: Account; // a vendor on no roster
let tenantA: Tenant;
let tenantB: Tenant;

const platformDb = () => openPlatformDb(config.dbPath);

/** Ties an identity to an account the way slice 1's link flow does, without the browser. */
function link(
  account: Account,
  subject: string,
  provider: SsoProvider = 'google',
  tid: string = DIRECTORY,
): void {
  const db = platformDb();
  linkIdentity(
    db,
    account.id,
    {
      provider,
      issuer:
        provider === 'google'
          ? 'https://accounts.google.com'
          : `https://login.microsoftonline.com/${tid}/v2.0`,
      subject,
    },
    { actor: SETUP },
  );
  db.close();
}

async function build(over: Partial<ServerConfig> = {}): Promise<FastifyInstance> {
  return buildApp({
    config: { ...config, ...over },
    logger: false,
    sso: { http: fake.http, now: () => clock },
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-sso-'));
  clock = new Date();
  fake = await FakeProvider.create();
  config = {
    port: 0,
    dbPath: join(dir, 'platform.sqlite'),
    storageRoot: join(dir, 'storage'),
    baseDomain: BASE,
    sso: {
      callbackOrigin: ORIGIN,
      providers: {
        google: { clientId: CLIENT_IDS.google, clientSecret: CLIENT_SECRETS.google },
        microsoft: {
          clientId: CLIENT_IDS.microsoft,
          clientSecret: CLIENT_SECRETS.microsoft,
        },
      },
    },
  };
  const platform = openPlatformDb(config.dbPath);
  const make = (name: string, over: Partial<Parameters<typeof createAccount>[1]> = {}) =>
    createAccount(platform, {
      email: `${name}@example.com`,
      passwordHash: hashPassword(`${name}-pw`),
      actor: SETUP,
      ...over,
    });
  make('bob', { role: 'vendor' }); // made first so no tenant id equals its founder's account id
  alice = make('alice');
  carol = make('carol');
  erin = make('erin', { role: 'vendor' });
  dave = make('dave', { role: 'vendor' });
  tenantA = getTenantForAccount(platform, alice.id)!.tenant;
  tenantB = getTenantForAccount(platform, carol.id)!.tenant;
  pam = make('pam', {
    passwordHash: NO_PASSWORD_HASH,
    joinTenant: { tenantId: tenantA.id, role: 'pm' },
  });
  setTenantSlug(platform, { tenantId: tenantA.id, slug: 'alpha', actor: SETUP });
  setTenantSlug(platform, { tenantId: tenantB.id, slug: 'beta', actor: SETUP });
  for (const tenant of [tenantA, tenantB]) {
    addRosterMembership(platform, { tenantId: tenant.id, accountId: erin.id });
    const roster = openOrCreateRoster(config.storageRoot, tenant);
    addVendor(roster, { accountId: erin.id, displayName: 'Erin', actor: SETUP });
    roster.close();
  }
  platform.close();
  app = await build();
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const at = (host: string, token?: string) => ({
  host,
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

interface Attempt {
  readonly state: string;
  readonly nonce: string;
  readonly url: URL;
}

/** Starts a sign-in on a host and reads back what the browser would be sent to the provider with. */
async function begin(
  host: string,
  provider: SsoProvider = 'google',
  token?: string,
  path = '/api/login/sso/start',
): Promise<Attempt> {
  const res = await app.inject({
    method: 'POST',
    url: path,
    headers: at(host, token),
    payload: { provider, binding: BINDING },
  });
  expect(res.statusCode, res.body).toBe(200);
  const url = new URL(res.json().url);
  return {
    state: url.searchParams.get('state')!,
    nonce: url.searchParams.get('nonce')!,
    url,
  };
}

let codeCounter = 0;

/** The person signs in at the provider and the provider sends the browser to the callback host. */
async function viaProvider(
  attempt: Attempt,
  provider: SsoProvider,
  subject: string,
  over: Partial<Parameters<FakeProvider['idToken']>[0]> = {},
  state = attempt.state,
) {
  codeCounter += 1;
  const code = `provider-code-${codeCounter}`;
  fake.issueCode(
    code,
    await fake.idToken({ provider, subject, nonce: attempt.nonce, ...over }),
  );
  return app.inject({
    method: 'GET',
    url: `${CALLBACK}?code=${code}&state=${encodeURIComponent(state)}`,
    headers: { host: AUTH_HOST },
  });
}

/** The hand-off code the callback host put in the fragment, or the word that says it refused. */
const fragmentOf = (location: string | string[] | undefined): string => {
  const hash = new URL(String(location), 'http://x.invalid').hash;
  expect(hash.startsWith('#sso=')).toBe(true);
  return hash.slice('#sso='.length);
};

const redeem = (host: string, code: string, binding = BINDING) =>
  app.inject({
    method: 'POST',
    url: '/api/login/sso/redeem',
    headers: at(host),
    payload: { code, binding },
  });

/** The whole flow, to a redeem response. */
async function signIn(
  host: string,
  provider: SsoProvider,
  subject: string,
  over: Partial<Parameters<FakeProvider['idToken']>[0]> = {},
) {
  const attempt = await begin(host, provider);
  const back = await viaProvider(attempt, provider, subject, over);
  expect(back.statusCode).toBe(302);
  return redeem(host, fragmentOf(back.headers.location));
}

const failures = () => {
  const db = platformDb();
  try {
    return (
      db
        .prepare(
          "SELECT detail, tenant_id FROM audit_event WHERE action = 'auth.sso_login_failed' ORDER BY id",
        )
        .all() as { detail: string; tenant_id: number | null }[]
    ).map((r) => ({ ...JSON.parse(r.detail), tenant_id: r.tenant_id }));
  } finally {
    db.close();
  }
};

describe('starting a sign-in', () => {
  it('lists the providers the operator has registered', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/login/sso/providers',
      headers: at(HOST_A),
    });
    expect(res.json()).toEqual({ providers: ['google', 'microsoft'] });
  });

  it('lists none when single sign-on is not configured', async () => {
    const off = await build({ sso: undefined });
    const res = await off.inject({
      method: 'GET',
      url: '/api/login/sso/providers',
      headers: at(HOST_A),
    });
    expect(res.json()).toEqual({ providers: [] });
    const start = await off.inject({
      method: 'POST',
      url: '/api/login/sso/start',
      headers: at(HOST_A),
      payload: { provider: 'google', binding: BINDING },
    });
    expect(start.statusCode).toBe(400);
    await off.close();
  });

  it('sends the browser to the provider with PKCE, a state, a nonce and the callback host', async () => {
    const { url } = await begin(HOST_A, 'google');
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_IDS.google);
    expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}${CALLBACK}`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('scope')).toBe('openid');
    expect(url.searchParams.get('state')).not.toBe(url.searchParams.get('nonce'));
    expect((await begin(HOST_A, 'microsoft')).url.origin).toBe(
      'https://login.microsoftonline.com',
    );
  });

  it('mints a different state, nonce and challenge every time', async () => {
    const a = await begin(HOST_A);
    const b = await begin(HOST_A);
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.url.searchParams.get('code_challenge')).not.toBe(
      b.url.searchParams.get('code_challenge'),
    );
  });

  it('refuses an unknown provider and a browser secret that is missing or too short', async () => {
    for (const payload of [
      { provider: 'github', binding: BINDING },
      { provider: 'google' },
      { provider: 'google', binding: 'short' },
      { binding: BINDING },
      {},
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/login/sso/start',
        headers: at(HOST_A),
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("is not served on a host that is no tenant's", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/login/sso/start',
      headers: at(`nobody.${BASE}`),
      payload: { provider: 'google', binding: BINDING },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('signing in', () => {
  it("opens a session for the linked account on its tenant's host", async () => {
    link(alice, 'alice-sub');
    const res = await signIn(HOST_A, 'google', 'alice-sub');
    expect(res.statusCode, res.body).toBe(200);
    const { token, account } = res.json();
    expect(account.email).toBe('alice@example.com');
    expect(JSON.stringify(res.json())).not.toContain('passwordHash');
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: at(HOST_A, token),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe('alice@example.com');
  });

  it("sends the browser back to its own tenant's host, never to one a request named", async () => {
    link(alice, 'alice-sub');
    const attempt = await begin(HOST_A);
    const back = await viaProvider(attempt, 'google', 'alice-sub');
    expect(back.statusCode).toBe(302);
    const location = new URL(String(back.headers.location));
    expect(location.origin).toBe(`http://${HOST_A}`);
    expect(location.pathname).toBe('/');
    expect(back.headers['cache-control']).toBe('no-store');
    expect(back.headers['referrer-policy']).toBe('no-referrer');
  });

  it('gives a session that works only on the host it was redeemed on', async () => {
    link(alice, 'alice-sub');
    const { token } = (await signIn(HOST_A, 'google', 'alice-sub')).json();
    const elsewhere = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: at(HOST_B, token),
    });
    expect(elsewhere.statusCode).toBe(401);
  });

  it('signs a vendor in on any tenant whose roster they are on', async () => {
    link(erin, 'erin-sub', 'microsoft');
    for (const host of [HOST_A, HOST_B]) {
      const res = await signIn(host, 'microsoft', 'erin-sub');
      expect(res.statusCode, host).toBe(200);
      expect(res.json().account.role).toBe('vendor');
    }
  });

  it('keeps one Microsoft subject in two directories two people', async () => {
    link(erin, 'same-sub', 'microsoft', DIRECTORY);
    const other = '99999999-2222-4333-8444-555555555555';
    const res = await signIn(HOST_A, 'microsoft', 'same-sub', { tid: other });
    expect(res.statusCode).toBe(401);
    expect((await signIn(HOST_A, 'microsoft', 'same-sub')).statusCode).toBe(200);
  });

  it('logs the sign-in as a provider sign-in naming the provider, and nothing from it', async () => {
    link(alice, 'alice-subject-value');
    await signIn(HOST_A, 'google', 'alice-subject-value');
    const db = platformDb();
    const rows = db
      .prepare('SELECT action, detail, tenant_id FROM audit_event')
      .all() as {
      action: string;
      detail: string | null;
      tenant_id: number | null;
    }[];
    db.close();
    const login = rows.filter((r) => r.action === 'auth.sso_login');
    expect(login).toHaveLength(1);
    expect(JSON.parse(login[0]!.detail!)).toEqual({ provider: 'google' });
    expect(login[0]!.tenant_id).toBe(tenantA.id);
    const all = JSON.stringify(rows);
    for (const secret of [
      'alice-subject-value',
      'accounts.google.com',
      'alice@example.com',
    ]) {
      expect(all).not.toContain(secret);
    }
  });

  it("refreshes the provider's keys once when a token is signed with one it has not seen", async () => {
    link(alice, 'alice-sub');
    expect((await signIn(HOST_A, 'google', 'alice-sub')).statusCode).toBe(200);
    expect(fake.jwksFetches).toBe(1);
    await fake.rotate();
    expect((await signIn(HOST_A, 'google', 'alice-sub')).statusCode).toBe(200);
    expect(fake.jwksFetches).toBe(2);
  });

  it("reads the provider's keys once and not on every sign-in", async () => {
    link(alice, 'alice-sub');
    await signIn(HOST_A, 'google', 'alice-sub');
    await signIn(HOST_A, 'google', 'alice-sub');
    expect(fake.jwksFetches).toBe(1);
  });
});

describe('what a refusal looks like', () => {
  it('is one answer for an identity nobody linked, creating no account', async () => {
    const before = openPlatformDb(config.dbPath);
    const accounts = listAccounts(before).length;
    before.close();
    const res = await signIn(HOST_A, 'google', 'a-stranger');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(REFUSED);
    const after = openPlatformDb(config.dbPath);
    expect(listAccounts(after).length).toBe(accounts);
    after.close();
    expect(failures().at(-1)).toMatchObject({
      provider: 'google',
      reason: 'unknown_identity',
    });
  });

  it('is the same answer for an account that belongs to another tenant', async () => {
    link(carol, 'carol-sub');
    const stranger = await signIn(HOST_A, 'google', 'nobody-sub');
    const offHost = await signIn(HOST_A, 'google', 'carol-sub');
    expect(offHost.statusCode).toBe(stranger.statusCode);
    expect(offHost.json()).toEqual(stranger.json());
    expect(failures().map((f) => f.reason)).toEqual([
      'unknown_identity',
      'not_on_this_host',
    ]);
    expect((await signIn(HOST_B, 'google', 'carol-sub')).statusCode).toBe(200);
  });

  it('is the same answer for a vendor on no roster', async () => {
    link(dave, 'dave-sub');
    const res = await signIn(HOST_A, 'google', 'dave-sub');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(REFUSED);
  });

  it.each([
    ["another app's audience", { aud: 'someone-else' }, 'audience'],
    ['another issuer', { iss: 'https://evil.example' }, 'issuer'],
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 60 }, 'expired'],
    ['a key the provider does not publish', { forged: true }, 'signature'],
  ])(
    'refuses %s at the callback, and no code is handed on',
    async (_name, over, reason) => {
      link(alice, 'alice-sub');
      const attempt = await begin(HOST_A);
      const back = await viaProvider(attempt, 'google', 'alice-sub', over);
      expect(back.statusCode).toBe(302);
      expect(new URL(String(back.headers.location)).hash).toBe('#sso=refused');
      expect(failures().at(-1)).toMatchObject({
        provider: 'google',
        reason,
        tenant_id: tenantA.id,
      });
    },
  );

  it('refuses a nonce from another attempt', async () => {
    link(alice, 'alice-sub');
    const attempt = await begin(HOST_A);
    const back = await viaProvider(attempt, 'google', 'alice-sub', {
      nonce: 'another-attempts',
    });
    expect(new URL(String(back.headers.location)).hash).toBe('#sso=refused');
    expect(failures().at(-1)?.reason).toBe('nonce');
  });

  it("refuses a Microsoft token whose issuer is not its own directory's", async () => {
    link(erin, 'erin-sub', 'microsoft');
    const attempt = await begin(HOST_A, 'microsoft');
    const back = await viaProvider(attempt, 'microsoft', 'erin-sub', {
      iss: 'https://login.microsoftonline.com/99999999-2222-4333-8444-555555555555/v2.0',
    });
    expect(new URL(String(back.headers.location)).hash).toBe('#sso=refused');
    expect(failures().at(-1)?.reason).toBe('issuer');
  });

  it('refuses when the provider reports an error, without exchanging anything', async () => {
    const attempt = await begin(HOST_A);
    const back = await app.inject({
      method: 'GET',
      url: `${CALLBACK}?error=access_denied&state=${encodeURIComponent(attempt.state)}`,
      headers: { host: AUTH_HOST },
    });
    expect(new URL(String(back.headers.location)).hash).toBe('#sso=refused');
    expect(failures().at(-1)?.reason).toBe('provider_error');
    expect(fake.exchanges).toHaveLength(0);
  });

  it('refuses when the code cannot be exchanged, and carries nothing the provider said', async () => {
    const attempt = await begin(HOST_A);
    const back = await app.inject({
      method: 'GET',
      url: `${CALLBACK}?code=never-issued&state=${encodeURIComponent(attempt.state)}`,
      headers: { host: AUTH_HOST },
    });
    expect(new URL(String(back.headers.location)).hash).toBe('#sso=refused');
    expect(failures().at(-1)?.reason).toBe('exchange_failed');
    expect(JSON.stringify(failures())).not.toContain('never-issued');
  });

  it("exchanges the code with the verifier, the redirect and the client's own credentials", async () => {
    const attempt = await begin(HOST_A, 'microsoft');
    await viaProvider(attempt, 'microsoft', 'erin-sub');
    expect(fake.exchanges).toHaveLength(1);
    expect(fake.exchanges[0]).toMatchObject({
      provider: 'microsoft',
      redirectUri: `${ORIGIN}${CALLBACK}`,
      clientId: CLIENT_IDS.microsoft,
      clientSecret: CLIENT_SECRETS.microsoft,
    });
    expect(fake.exchanges[0]!.codeVerifier.length).toBeGreaterThanOrEqual(43);
  });
});

describe('the callback host', () => {
  it('answers a state nobody minted with a fixed 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${CALLBACK}?code=x&state=${'z'.repeat(43)}`,
      headers: { host: AUTH_HOST },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });

  it('answers a missing state the same way', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${CALLBACK}?code=x`,
      headers: { host: AUTH_HOST },
    });
    expect(res.statusCode).toBe(404);
  });

  it('takes a state once: a replayed callback finds nothing', async () => {
    link(alice, 'alice-sub');
    const attempt = await begin(HOST_A);
    expect((await viaProvider(attempt, 'google', 'alice-sub')).statusCode).toBe(302);
    const again = await viaProvider(attempt, 'google', 'alice-sub');
    expect(again.statusCode).toBe(404);
  });

  it('expires an attempt', async () => {
    const attempt = await begin(HOST_A);
    clock = new Date(clock.getTime() + 6 * 60 * 1000);
    expect((await viaProvider(attempt, 'google', 'alice-sub')).statusCode).toBe(404);
  });

  it('serves the callback and nothing else', async () => {
    for (const [method, url] of [
      ['GET', '/'],
      ['GET', '/index.html'],
      ['POST', '/api/login'],
      ['POST', '/api/login/sso/start'],
      ['POST', '/api/login/sso/redeem'],
      ['GET', '/api/login/sso/providers'],
      ['GET', '/api/me'],
      ['POST', CALLBACK],
    ] as const) {
      const res = await app.inject({ method, url, headers: { host: AUTH_HOST } });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it("is not the callback on a tenant's host", async () => {
    const attempt = await begin(HOST_A);
    fake.issueCode(
      'c',
      await fake.idToken({ provider: 'google', subject: 's', nonce: attempt.nonce }),
    );
    const res = await app.inject({
      method: 'GET',
      url: `${CALLBACK}?code=c&state=${encodeURIComponent(attempt.state)}`,
      headers: { host: HOST_A },
    });
    expect(res.statusCode).toBe(404);
    // And the attempt is still there for the callback host: nothing was spent.
    expect(fake.exchanges).toHaveLength(0);
  });

  it('is not served on the base domain itself', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${CALLBACK}?code=c&state=s`,
      headers: { host: BASE },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("the hand-off to a tenant's host", () => {
  it('works once', async () => {
    link(alice, 'alice-sub');
    const attempt = await begin(HOST_A);
    const code = fragmentOf(
      (await viaProvider(attempt, 'google', 'alice-sub')).headers.location,
    );
    expect((await redeem(HOST_A, code)).statusCode).toBe(200);
    const second = await redeem(HOST_A, code);
    expect(second.statusCode).toBe(401);
    expect(second.json()).toEqual(REFUSED);
  });

  it("works only on the tenant's host it started on, and is spent by the try", async () => {
    link(erin, 'erin-sub');
    const attempt = await begin(HOST_A);
    const code = fragmentOf(
      (await viaProvider(attempt, 'google', 'erin-sub')).headers.location,
    );
    // Erin is on both rosters, so only the host can be what refuses this.
    const wrong = await redeem(HOST_B, code);
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual(REFUSED);
    expect((await redeem(HOST_A, code)).statusCode).toBe(401);
    expect(failures().map((f) => f.reason)).toEqual([
      'handoff_refused',
      'handoff_refused',
    ]);
  });

  it('works only for the browser that started it', async () => {
    link(alice, 'alice-sub');
    const attempt = await begin(HOST_A);
    const code = fragmentOf(
      (await viaProvider(attempt, 'google', 'alice-sub')).headers.location,
    );
    expect(
      (await redeem(HOST_A, code, 'some-other-browsers-secret-999')).statusCode,
    ).toBe(401);
    expect((await redeem(HOST_A, code)).statusCode).toBe(401);
  });

  it('expires within a minute', async () => {
    link(alice, 'alice-sub');
    const attempt = await begin(HOST_A);
    const code = fragmentOf(
      (await viaProvider(attempt, 'google', 'alice-sub')).headers.location,
    );
    clock = new Date(clock.getTime() + 61 * 1000);
    expect((await redeem(HOST_A, code)).statusCode).toBe(401);
  });

  it('does not take a state for a code', async () => {
    const attempt = await begin(HOST_A);
    expect((await redeem(HOST_A, attempt.state)).statusCode).toBe(401);
  });

  it('refuses a body with no code or no browser secret', async () => {
    for (const payload of [
      {},
      { code: 'x' },
      { binding: BINDING },
      { code: 5, binding: BINDING },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/login/sso/redeem',
        headers: at(HOST_A),
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe('an account with no password', () => {
  it('cannot be signed into with a password, whatever is typed', async () => {
    for (const password of ['', '!', NO_PASSWORD_HASH, 'pam-pw', 'password']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/login',
        headers: at(HOST_A),
        payload: { email: 'pam@example.com', password },
      });
      expect(res.statusCode, password).toBe(401);
    }
  });

  it('signs in through a provider', async () => {
    link(pam, 'pam-sub', 'microsoft');
    const res = await signIn(HOST_A, 'microsoft', 'pam-sub');
    expect(res.statusCode).toBe(200);
    expect(res.json().account.email).toBe('pam@example.com');
  });
});

describe('linking and unlinking, from a session', () => {
  const login = async (account: Account, host = HOST_A): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: at(host),
      payload: { email: account.email, password: `${account.email.split('@')[0]}-pw` },
    });
    expect(res.statusCode).toBe(200);
    return res.json().token;
  };

  /** The whole link flow to the redeem response. */
  async function linkFlow(
    token: string,
    provider: SsoProvider,
    subject: string,
    binding = BINDING,
  ) {
    const attempt = await begin(HOST_A, provider, token, '/api/me/identities/start');
    const back = await viaProvider(attempt, provider, subject);
    expect(back.statusCode).toBe(302);
    return app.inject({
      method: 'POST',
      url: '/api/me/identities/redeem',
      headers: at(HOST_A, token),
      payload: { code: fragmentOf(back.headers.location), binding },
    });
  }

  it('ties the identity to the account that started it, and it then signs in', async () => {
    const token = await login(alice);
    const res = await linkFlow(token, 'google', 'fresh-sub');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().identities).toEqual([
      {
        id: expect.any(Number),
        provider: 'google',
        linkedAt: expect.any(String),
        lastLoginAt: null,
      },
    ]);
    expect((await signIn(HOST_A, 'google', 'fresh-sub')).json().account.email).toBe(
      'alice@example.com',
    );
  });

  it('shows an account its links: the provider and when, never the subject', async () => {
    link(alice, 'secret-subject-value');
    const token = await login(alice);
    const res = await app.inject({
      method: 'GET',
      url: '/api/me/identities',
      headers: at(HOST_A, token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().identities).toHaveLength(1);
    expect(res.body).not.toContain('secret-subject-value');
    expect(res.body).not.toContain('accounts.google.com');
  });

  it('needs a session to start, redeem, list or remove', async () => {
    for (const [method, url] of [
      ['GET', '/api/me/identities'],
      ['POST', '/api/me/identities/start'],
      ['POST', '/api/me/identities/redeem'],
      ['DELETE', '/api/me/identities/1'],
    ] as const) {
      const res = await app.inject({ method, url, headers: at(HOST_A), payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("refuses a link redeemed from another account's session, so a victim cannot complete it", async () => {
    const aliceToken = await login(alice);
    const attempt = await begin(HOST_A, 'google', aliceToken, '/api/me/identities/start');
    const code = fragmentOf(
      (await viaProvider(attempt, 'google', 'victim-sub')).headers.location,
    );
    // The code reaches a browser signed in as someone else on the same host.
    link(pam, 'pam-sub');
    const pamToken = (await signIn(HOST_A, 'google', 'pam-sub')).json().token;
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/identities/redeem',
      headers: at(HOST_A, pamToken),
      payload: { code, binding: BINDING },
    });
    expect(res.statusCode).toBe(400);
    const db = platformDb();
    const linked = db
      .prepare("SELECT COUNT(*) AS n FROM account_identity WHERE subject = 'victim-sub'")
      .get();
    db.close();
    expect(linked).toEqual({ n: 0 });
  });

  it('refuses an identity that already opens another account', async () => {
    link(carol, 'taken-sub');
    const token = await login(alice);
    const res = await linkFlow(token, 'google', 'taken-sub');
    expect(res.statusCode).toBe(409);
  });

  it('refuses a login code as a link and a link code as a login', async () => {
    const token = await login(alice);
    const loginAttempt = await begin(HOST_A);
    const loginCode = fragmentOf(
      (await viaProvider(loginAttempt, 'google', 'x')).headers.location,
    );
    const asLink = await app.inject({
      method: 'POST',
      url: '/api/me/identities/redeem',
      headers: at(HOST_A, token),
      payload: { code: loginCode, binding: BINDING },
    });
    expect(asLink.statusCode).toBe(400);
    const linkAttempt = await begin(HOST_A, 'google', token, '/api/me/identities/start');
    const linkCode = fragmentOf(
      (await viaProvider(linkAttempt, 'google', 'y')).headers.location,
    );
    expect((await redeem(HOST_A, linkCode)).statusCode).toBe(401);
  });

  it('removes a link, and the identity no longer signs in', async () => {
    link(alice, 'alice-sub');
    const token = await login(alice);
    const [{ id }] = (
      await app.inject({
        method: 'GET',
        url: '/api/me/identities',
        headers: at(HOST_A, token),
      })
    ).json().identities;
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/me/identities/${id}`,
      headers: at(HOST_A, token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().identities).toEqual([]);
    expect((await signIn(HOST_A, 'google', 'alice-sub')).statusCode).toBe(401);
  });

  it('will not remove the only way into an account with no password', async () => {
    link(pam, 'pam-sub');
    const token = (await signIn(HOST_A, 'google', 'pam-sub')).json().token;
    const [{ id }] = (
      await app.inject({
        method: 'GET',
        url: '/api/me/identities',
        headers: at(HOST_A, token),
      })
    ).json().identities;
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/me/identities/${id}`,
      headers: at(HOST_A, token),
    });
    expect(res.statusCode).toBe(409);
    expect((await signIn(HOST_A, 'google', 'pam-sub')).statusCode).toBe(200);
  });

  it("answers another account's link, and one that is not there, with the same 404", async () => {
    link(carol, 'carol-sub');
    const db = platformDb();
    const carolsLink = (
      db.prepare('SELECT id FROM account_identity').get() as { id: number }
    ).id;
    db.close();
    const token = await login(alice);
    const theirs = await app.inject({
      method: 'DELETE',
      url: `/api/me/identities/${carolsLink}`,
      headers: at(HOST_A, token),
    });
    const missing = await app.inject({
      method: 'DELETE',
      url: '/api/me/identities/999999',
      headers: at(HOST_A, token),
    });
    expect(theirs.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(theirs.body).toBe(missing.body);
  });
});

describe('with no base domain', () => {
  let bare: FastifyInstance;
  const LOCAL = 'localhost:3400';

  beforeEach(async () => {
    const { baseDomain: _unused, ...rest } = config;
    void _unused;
    bare = await buildApp({
      config: { ...rest, sso: { ...config.sso!, callbackOrigin: `http://${LOCAL}` } },
      logger: false,
      sso: { http: fake.http, now: () => clock },
    });
  });
  afterEach(async () => {
    await bare.close();
  });

  it('is one host: the callback, the redeem and the session are all on it', async () => {
    link(alice, 'alice-sub');
    const start = await bare.inject({
      method: 'POST',
      url: '/api/login/sso/start',
      headers: { host: LOCAL },
      payload: { provider: 'google', binding: BINDING },
    });
    const url = new URL(start.json().url);
    expect(url.searchParams.get('redirect_uri')).toBe(`http://${LOCAL}${CALLBACK}`);
    fake.issueCode(
      'c1',
      await fake.idToken({
        provider: 'google',
        subject: 'alice-sub',
        nonce: url.searchParams.get('nonce')!,
      }),
    );
    const back = await bare.inject({
      method: 'GET',
      url: `${CALLBACK}?code=c1&state=${encodeURIComponent(url.searchParams.get('state')!)}`,
      headers: { host: LOCAL },
    });
    expect(back.statusCode).toBe(302);
    expect(String(back.headers.location).startsWith('/#sso=')).toBe(true);
    const res = await bare.inject({
      method: 'POST',
      url: '/api/login/sso/redeem',
      headers: { host: LOCAL },
      payload: { code: fragmentOf(back.headers.location), binding: BINDING },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().account.email).toBe('alice@example.com');
  });
});
