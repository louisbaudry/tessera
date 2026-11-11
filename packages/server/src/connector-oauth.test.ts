/**
 * Sign-in from a chat host (backlog #381, `planning/chat-connector-spec.md` §6b), through
 * Fastify's `inject` and, for the flow as a real client runs it, through the official MCP
 * client over a socket. What it holds:
 *
 * - the endpoint's 401 points at metadata that names a configured origin, never the `Host`;
 * - a code only ever goes to an address the client registered, and only a signed-in member of
 *   the tenant can cause one;
 * - a code is exchanged once, with its verifier; refresh tokens rotate; a spent one ends the
 *   connection; every refusal at the token endpoint is the same `invalid_grant`;
 * - the access token opens the connector and nothing else.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashPassword, type AuditActor } from '@cat-tool/core';
import {
  createAccount,
  getTenantForAccount,
  listEvents,
  MAX_CLIENT_REGISTRATIONS_PER_HOUR,
  openPlatformDb,
  setTenantSlug,
  type Account,
} from '@cat-tool/db';
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';
import { loadConfig } from './config.js';
import { MCP_PATH } from './connector.js';

const SETUP: AuditActor = { actor: { kind: 'system', name: 'test-setup' }, label: null };
const ORIGIN = 'https://cat.example.org';
const REDIRECT = 'https://chat.example/callback';
const VERIFIER = 'v'.repeat(43);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;
let alice: Account;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-oauth-'));
  config = {
    port: 0,
    dbPath: join(dir, 'platform.sqlite'),
    storageRoot: join(dir, 'storage'),
    publicOrigin: ORIGIN,
  };
  const platform = openPlatformDb(config.dbPath);
  const make = (name: string, extra: Record<string, unknown> = {}) =>
    createAccount(platform, {
      email: `${name}@example.com`,
      passwordHash: hashPassword(`${name}-pw`),
      actor: SETUP,
      ...extra,
    });
  // A vendor first, so no tenant's id equals its founder's account id.
  make('vera', { role: 'vendor' });
  alice = make('alice');
  make('carol');
  platform.close();
  app = await buildApp({ config, logger: false });
});

afterEach(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const as = (token: string) => ({ authorization: `Bearer ${token}` });

async function login(
  name: string,
  on: FastifyInstance = app,
  host?: string,
): Promise<string> {
  const res = await on.inject({
    method: 'POST',
    url: '/api/login',
    headers: host ? { host } : {},
    payload: { email: `${name}@example.com`, password: `${name}-pw` },
  });
  return (res.json() as { token: string }).token;
}

async function register(
  payload: Record<string, unknown> = {},
  on: FastifyInstance = app,
  host?: string,
) {
  const res = await on.inject({
    method: 'POST',
    url: '/api/oauth/register',
    headers: host ? { host } : {},
    payload: { client_name: 'Chat host', redirect_uris: [REDIRECT], ...payload },
  });
  return { res, clientId: (res.json() as { client_id?: string }).client_id ?? '' };
}

const authorizeUrl = (
  clientId: string,
  over: Record<string, string | undefined> = {},
) => {
  const params: Record<string, string | undefined> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'xyz',
    ...over,
  };
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) query.set(k, v);
  return `/api/oauth/authorize?${query.toString()}`;
};

/** The person's answer on the consent page; returns where the browser is sent. */
async function consent(
  session: string,
  clientId: string,
  over: Record<string, unknown> = {},
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/oauth/consent',
    headers: as(session),
    payload: {
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      state: 'xyz',
      allow: true,
      ...over,
    },
  });
  const redirect = (res.json() as { redirect?: string }).redirect;
  return { res, redirect: redirect ? new URL(redirect) : null };
}

/** A form-encoded post to the token endpoint, as the standard has it. */
function token(fields: Record<string, string>) {
  return app.inject({
    method: 'POST',
    url: '/api/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  });
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

/** Registers, consents as `name` and exchanges: a whole sign-in. */
async function signIn(name = 'alice') {
  const { clientId } = await register();
  const session = await login(name);
  const { redirect } = await consent(session, clientId);
  const res = await token({
    grant_type: 'authorization_code',
    code: redirect!.searchParams.get('code')!,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
  });
  expect(res.statusCode, res.body).toBe(200);
  return {
    clientId,
    session,
    code: redirect!.searchParams.get('code')!,
    tokens: res.json() as Tokens,
  };
}

const ping = (accessToken: string | null, on: FastifyInstance = app) =>
  on.inject({
    method: 'POST',
    url: MCP_PATH,
    headers: accessToken === null ? {} : as(accessToken),
    payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
  });

describe('metadata', () => {
  it('names the configured origin, whatever host the request claims', async () => {
    for (const url of [
      '/.well-known/oauth-protected-resource',
      `/.well-known/oauth-protected-resource${MCP_PATH}`,
    ]) {
      const res = await app.inject({ url, headers: { host: 'evil.example' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        resource: `${ORIGIN}${MCP_PATH}`,
        authorization_servers: [ORIGIN],
        bearer_methods_supported: ['header'],
      });
    }
    const server = await app.inject({
      url: '/.well-known/oauth-authorization-server',
      headers: { host: 'evil.example' },
    });
    expect(server.json()).toEqual({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/api/oauth/authorize`,
      token_endpoint: `${ORIGIN}/api/oauth/token`,
      registration_endpoint: `${ORIGIN}/api/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
    expect(server.body).not.toContain('evil.example');
  });

  it('the endpoint’s 401 points at the metadata', async () => {
    const res = await ping(null);
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
    );
  });

  it('with no origin configured, sign-in is off and the endpoint says nothing of it', async () => {
    const { publicOrigin: _off, ...bare } = config;
    const plain = await buildApp({ config: bare, logger: false });
    try {
      for (const url of [
        '/.well-known/oauth-protected-resource',
        '/.well-known/oauth-authorization-server',
        '/api/oauth/authorize?client_id=x&redirect_uri=y',
      ]) {
        expect((await plain.inject({ url })).statusCode, url).toBe(404);
      }
      expect((await register({}, plain)).res.statusCode).toBe(404);
      const res = await ping(null, plain);
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBeUndefined();
    } finally {
      await plain.close();
    }
  });
});

describe('CAT_PUBLIC_ORIGIN', () => {
  const env = (value: string, extra: Record<string, string> = {}) =>
    loadConfig({ CAT_PUBLIC_ORIGIN: value, ...extra });

  it('is a bare https origin, or http to this machine', () => {
    expect(env('https://cat.example.org').publicOrigin).toBe('https://cat.example.org');
    expect(env('http://localhost:3400').publicOrigin).toBe('http://localhost:3400');
    expect(env('').publicOrigin).toBeUndefined();
  });

  it.each([
    'http://cat.example.org',
    'https://cat.example.org/',
    'https://cat.example.org/app',
    'cat.example.org',
  ])('refuses %s', (value) => {
    expect(() => env(value)).toThrow(/CAT_PUBLIC_ORIGIN/);
  });

  it('is refused beside a base domain', () => {
    expect(() =>
      env('https://cat.example.org', { CAT_BASE_DOMAIN: 'cat.example' }),
    ).toThrow(/CAT_BASE_DOMAIN/);
  });
});

describe('registration', () => {
  it('registers a public client and says so', async () => {
    const { res, clientId } = await register();
    expect(res.statusCode).toBe(201);
    expect(clientId).toMatch(/^[\w-]{32,}$/);
    expect(res.json()).toMatchObject({
      client_name: 'Chat host',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    expect(res.json()).not.toHaveProperty('client_secret');
  });

  it.each([
    [{ redirect_uris: ['http://chat.example/callback'] }, 'invalid_redirect_uri'],
    [{ redirect_uris: [] }, 'invalid_redirect_uri'],
    [{ redirect_uris: ['https://chat.example/cb#x'] }, 'invalid_redirect_uri'],
    [{ client_name: 'x'.repeat(81) }, 'invalid_client_metadata'],
    [{ token_endpoint_auth_method: 'client_secret_post' }, 'invalid_client_metadata'],
  ])('refuses %j', async (payload, error) => {
    const { res } = await register(payload);
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe(error);
  });

  it('names a client that gave no name, and accepts a loopback address', async () => {
    const { res } = await register({
      client_name: undefined,
      redirect_uris: ['http://localhost/callback'],
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { client_name: string }).client_name).toBe('Unnamed client');
  });

  it('is capped by the hour', async () => {
    for (let i = 0; i < MAX_CLIENT_REGISTRATIONS_PER_HOUR; i += 1) {
      expect((await register()).res.statusCode).toBe(201);
    }
    const { res } = await register();
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('3600');
  });
});

describe('the authorization request', () => {
  it('hands a valid request to the consent page, in the fragment', async () => {
    const { clientId } = await register();
    const res = await app.inject({ url: authorizeUrl(clientId) });
    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    expect(location.startsWith('/#/connect?')).toBe(true);
    const page = new URLSearchParams(location.slice('/#/connect?'.length));
    expect(Object.fromEntries(page)).toEqual({
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      state: 'xyz',
    });
  });

  it('never redirects for an unknown client or an address that is not the client’s', async () => {
    const { clientId } = await register();
    for (const url of [
      authorizeUrl('unknown'),
      authorizeUrl(clientId, { redirect_uri: 'https://evil.example/callback' }),
      authorizeUrl(clientId, { redirect_uri: `${REDIRECT}/more` }),
      authorizeUrl(clientId, { redirect_uri: undefined }),
    ]) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(400);
      expect(res.headers.location).toBeUndefined();
    }
  });

  it.each([
    [{ response_type: 'token' }, 'unsupported_response_type'],
    [{ code_challenge: undefined }, 'invalid_request'],
    [{ code_challenge_method: 'plain' }, 'invalid_request'],
    [{ code_challenge_method: undefined }, 'invalid_request'],
    [{ resource: 'https://elsewhere.example/api/mcp' }, 'invalid_target'],
  ])('sends %j back to the client as an error, with its state', async (over, error) => {
    const { clientId } = await register();
    const res = await app.inject({ url: authorizeUrl(clientId, over) });
    expect(res.statusCode).toBe(302);
    const back = new URL(res.headers.location as string);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get('error')).toBe(error);
    expect(back.searchParams.get('state')).toBe('xyz');
    expect(back.searchParams.has('code')).toBe(false);
  });

  it('accepts the connector’s own address as the resource', async () => {
    const { clientId } = await register();
    const res = await app.inject({
      url: authorizeUrl(clientId, { resource: `${ORIGIN}${MCP_PATH}` }),
    });
    expect((res.headers.location as string).startsWith('/#/connect?')).toBe(true);
  });

  it('matches a loopback address on any port', async () => {
    const { clientId } = await register({ redirect_uris: ['http://localhost/callback'] });
    const ok = await app.inject({
      url: authorizeUrl(clientId, { redirect_uri: 'http://localhost:51234/callback' }),
    });
    expect((ok.headers.location as string).startsWith('/#/connect?')).toBe(true);
    const other = await app.inject({
      url: authorizeUrl(clientId, { redirect_uri: 'http://localhost:51234/other' }),
    });
    expect(other.statusCode).toBe(400);
  });
});

describe('consent', () => {
  it('needs a session to read the request or answer it', async () => {
    const { clientId } = await register();
    const query = `client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}`;
    expect((await app.inject({ url: `/api/oauth/request?${query}` })).statusCode).toBe(
      401,
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/oauth/consent',
      payload: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        allow: true,
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('shows the client’s claim and the checked address', async () => {
    const { clientId } = await register();
    const query = `client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}`;
    const show = async (name: string) =>
      (
        await app.inject({
          url: `/api/oauth/request?${query}`,
          headers: as(await login(name)),
        })
      ).json();
    expect(await show('alice')).toEqual({
      clientName: 'Chat host',
      redirectHost: 'chat.example',
      loopback: false,
      staff: true,
    });
    expect(await show('vera')).toMatchObject({ staff: false });
    const wrong = await app.inject({
      url: `/api/oauth/request?client_id=${clientId}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}`,
      headers: as(await login('alice')),
    });
    expect(wrong.statusCode).toBe(404);
  });

  it('a refusal goes back as access_denied, with no code', async () => {
    const { clientId } = await register();
    const { redirect } = await consent(await login('alice'), clientId, { allow: false });
    expect(redirect!.searchParams.get('error')).toBe('access_denied');
    expect(redirect!.searchParams.get('state')).toBe('xyz');
    expect(redirect!.searchParams.has('code')).toBe(false);
  });

  it('only `allow: true` is consent', async () => {
    const { clientId } = await register();
    for (const allow of [undefined, 'true', 1]) {
      const { redirect } = await consent(await login('alice'), clientId, { allow });
      expect(redirect!.searchParams.get('error')).toBe('access_denied');
    }
  });

  it('refuses a vendor, an unregistered address and a missing challenge', async () => {
    const { clientId } = await register();
    expect((await consent(await login('vera'), clientId)).res.statusCode).toBe(403);
    const session = await login('alice');
    expect(
      (await consent(session, clientId, { redirect_uri: 'https://evil.example/cb' })).res
        .statusCode,
    ).toBe(404);
    expect((await consent(session, 'unknown')).res.statusCode).toBe(404);
    expect(
      (await consent(session, clientId, { code_challenge: 'short' })).res.statusCode,
    ).toBe(400);
  });
});

describe('the token endpoint', () => {
  it('exchanges a code for tokens that open the connector and nothing else', async () => {
    const { tokens, session } = await signIn();
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    expect((await ping(tokens.access_token)).statusCode).toBe(200);
    // Not a session, and a session is not a connector token.
    const projects = await app.inject({
      url: '/api/projects',
      headers: as(tokens.access_token),
    });
    expect(projects.statusCode).toBe(401);
    expect((await ping(session)).statusCode).toBe(401);
    // The refresh token opens neither.
    expect((await ping(tokens.refresh_token)).statusCode).toBe(401);
  });

  it('answers with no-store', async () => {
    const { clientId } = await register();
    const { redirect } = await consent(await login('alice'), clientId);
    const res = await token({
      grant_type: 'authorization_code',
      code: redirect!.searchParams.get('code')!,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it.each([
    ['a wrong verifier', { code_verifier: 'w'.repeat(43) }],
    ['another redirect address', { redirect_uri: 'https://chat.example/other' }],
    ['another client', { client_id: 'someone-else' }],
  ])('refuses %s as invalid_grant, and the code is spent', async (_what, over) => {
    const { clientId } = await register();
    const { redirect } = await consent(await login('alice'), clientId);
    const fields = {
      grant_type: 'authorization_code',
      code: redirect!.searchParams.get('code')!,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    };
    const wrong = await token({ ...fields, ...over });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toEqual({ error: 'invalid_grant' });
    const right = await token(fields);
    expect(right.json()).toEqual({ error: 'invalid_grant' });
  });

  it('a code presented twice ends the connection it made', async () => {
    const { clientId, code, tokens } = await signIn();
    const again = await token({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    });
    expect(again.json()).toEqual({ error: 'invalid_grant' });
    expect((await ping(tokens.access_token)).statusCode).toBe(401);
  });

  it('rotates refresh tokens, and a spent one ends the connection', async () => {
    const { clientId, tokens } = await signIn();
    const refresh = (refresh_token: string) =>
      token({ grant_type: 'refresh_token', refresh_token, client_id: clientId });
    const second = await refresh(tokens.refresh_token);
    expect(second.statusCode, second.body).toBe(200);
    const next = second.json() as Tokens;
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect((await ping(next.access_token)).statusCode).toBe(200);
    expect((await ping(tokens.access_token)).statusCode).toBe(401);

    const replay = await refresh(tokens.refresh_token);
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toEqual({ error: 'invalid_grant' });
    expect((await ping(next.access_token)).statusCode).toBe(401);
    expect((await refresh(next.refresh_token)).json()).toEqual({
      error: 'invalid_grant',
    });
  });

  it('names what it cannot do, and refuses another resource', async () => {
    const { clientId, tokens } = await signIn();
    expect((await token({ grant_type: 'password', client_id: clientId })).json()).toEqual(
      {
        error: 'unsupported_grant_type',
      },
    );
    expect(
      (await token({ grant_type: 'refresh_token', client_id: clientId })).json(),
    ).toEqual({
      error: 'invalid_request',
    });
    expect(
      (
        await token({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          client_id: clientId,
          resource: 'https://elsewhere.example/api/mcp',
        })
      ).json(),
    ).toEqual({ error: 'invalid_target' });
    // The refused request spent nothing.
    const ok = await token({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      resource: `${ORIGIN}${MCP_PATH}`,
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe('connections', () => {
  it('lists the person’s own, and ending one closes the connector at once', async () => {
    const { tokens, session } = await signIn();
    const list = await app.inject({ url: '/api/connections', headers: as(session) });
    const { connections } = list.json() as {
      connections: { id: number; name: string }[];
    };
    expect(connections).toEqual([expect.objectContaining({ name: 'Chat host' })]);
    expect(list.body).not.toContain(tokens.access_token);

    // Someone else sees none of it and cannot end it.
    const carol = await login('carol');
    expect(
      (await app.inject({ url: '/api/connections', headers: as(carol) })).json(),
    ).toEqual({ connections: [] });
    const id = connections[0]!.id;
    const del = (who: string, what: string | number = id) =>
      app.inject({ method: 'DELETE', url: `/api/connections/${what}`, headers: as(who) });
    expect((await del(carol)).statusCode).toBe(404);
    expect((await del(session, 'x')).statusCode).toBe(404);
    expect((await del(session)).json()).toEqual({ ended: true });
    expect((await del(session)).statusCode).toBe(404);
    expect((await ping(tokens.access_token)).statusCode).toBe(401);

    const platform = openPlatformDb(config.dbPath);
    try {
      const log = listEvents(platform, { subjectType: 'account' })
        .filter((e) => e.action.startsWith('connector.'))
        .map((e) => [e.action, e.actor]);
      expect(log).toEqual([
        ['connector.connected', `account:${alice.id}`],
        ['connector.disconnected', `account:${alice.id}`],
      ]);
    } finally {
      platform.close();
    }
  });
});

describe('under a base domain', () => {
  it('a tenant’s host names itself, and a client registered there is unknown elsewhere', async () => {
    const platform = openPlatformDb(config.dbPath);
    const tenantOfName = (id: number) => getTenantForAccount(platform, id)!.tenant.id;
    const carol = (
      platform
        .prepare("SELECT id FROM account WHERE email = 'carol@example.com'")
        .get() as {
        id: number;
      }
    ).id;
    setTenantSlug(platform, {
      tenantId: tenantOfName(alice.id),
      slug: 'alpha',
      actor: SETUP,
    });
    setTenantSlug(platform, {
      tenantId: tenantOfName(carol),
      slug: 'beta',
      actor: SETUP,
    });
    platform.close();
    const { publicOrigin: _unused, ...bare } = config;
    const hosted = await buildApp({
      config: { ...bare, baseDomain: 'cat.example' },
      logger: false,
    });
    try {
      const meta = await hosted.inject({
        url: '/.well-known/oauth-protected-resource',
        headers: { host: 'alpha.cat.example' },
      });
      expect(meta.json()).toMatchObject({
        resource: `https://alpha.cat.example${MCP_PATH}`,
        authorization_servers: ['https://alpha.cat.example'],
      });
      const unknown = await hosted.inject({
        url: '/.well-known/oauth-protected-resource',
        headers: { host: 'nobody.cat.example' },
      });
      expect(unknown.statusCode).toBe(404);

      const { clientId } = await register({}, hosted, 'alpha.cat.example');
      const at = (host: string) =>
        hosted.inject({ url: authorizeUrl(clientId), headers: { host } });
      expect((await at('alpha.cat.example')).statusCode).toBe(302);
      expect((await at('beta.cat.example')).statusCode).toBe(400);

      // Carol, signed in at her own tenant's host, cannot consent to alpha's client.
      const session = await login('carol', hosted, 'beta.cat.example');
      const res = await hosted.inject({
        method: 'POST',
        url: '/api/oauth/consent',
        headers: { ...as(session), host: 'beta.cat.example' },
        payload: {
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: CHALLENGE,
          allow: true,
        },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await hosted.close();
    }
  });
});

/** A port nothing listens on, so the origin can be configured before the server starts. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

describe('the official MCP client', () => {
  it('discovers, registers, signs in with PKCE and calls a tool', async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const live = await buildApp({
      config: { ...config, publicOrigin: origin },
      logger: false,
    });
    await live.listen({ port, host: '127.0.0.1' });

    // What a chat host keeps between the two halves of a sign-in.
    const kept: {
      client?: OAuthClientInformationMixed;
      tokens?: OAuthTokens;
      verifier?: string;
      authorizeUrl?: URL;
    } = {};
    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return REDIRECT;
      },
      get clientMetadata() {
        return {
          client_name: 'Official client',
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        };
      },
      clientInformation: () => kept.client,
      saveClientInformation: (info) => {
        kept.client = info;
      },
      tokens: () => kept.tokens,
      saveTokens: (tokens) => {
        kept.tokens = tokens;
      },
      redirectToAuthorization: (url) => {
        kept.authorizeUrl = url;
      },
      saveCodeVerifier: (verifier) => {
        kept.verifier = verifier;
      },
      codeVerifier: () => kept.verifier ?? '',
    };
    const connectWith = () => {
      const transport = new StreamableHTTPClientTransport(
        new URL(`${origin}${MCP_PATH}`),
        {
          authProvider: provider,
        },
      );
      return { transport, client: new Client({ name: 'oauth-test', version: '0.0.0' }) };
    };

    try {
      // First half: no token, so the client reads the 401, the metadata, registers itself and
      // asks to send the browser to the authorization endpoint.
      const first = connectWith();
      await expect(first.client.connect(first.transport)).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
      expect(kept.client?.client_id).toMatch(/^[\w-]{32,}$/);
      expect(kept.authorizeUrl?.origin).toBe(origin);
      expect(kept.authorizeUrl?.pathname).toBe('/api/oauth/authorize');
      expect(kept.authorizeUrl?.searchParams.get('code_challenge_method')).toBe('S256');

      // The browser: the authorization endpoint hands it to the consent page, where a signed-in
      // person allows it.
      const hop = await fetch(kept.authorizeUrl!, { redirect: 'manual' });
      expect(hop.status).toBe(302);
      const page = new URLSearchParams(
        hop.headers.get('location')!.slice('/#/connect?'.length),
      );
      const session = await login('alice', live);
      const answer = await live.inject({
        method: 'POST',
        url: '/api/oauth/consent',
        headers: as(session),
        payload: { ...Object.fromEntries(page), allow: true },
      });
      const back = new URL((answer.json() as { redirect: string }).redirect);
      expect(back.searchParams.get('state')).toBe(
        kept.authorizeUrl!.searchParams.get('state'),
      );

      // Second half: the client exchanges the code with its own verifier, then connects.
      await first.transport.finishAuth(back.searchParams.get('code')!);
      expect(kept.tokens?.access_token).toBeTruthy();
      expect(kept.tokens?.refresh_token).toBeTruthy();
      const second = connectWith();
      await second.client.connect(second.transport);
      const { tools } = await second.client.listTools();
      expect(tools.map((t) => t.name)).toContain('list_projects');
      const listed = await second.client.callTool({
        name: 'list_projects',
        arguments: {},
      });
      expect(listed.isError).toBe(false);
      await second.client.close();
    } finally {
      await live.close();
    }
  });
});
