/**
 * A tenant's subdomain pins the request to that tenant (backlog #209,
 * `planning/tenant-spec.md` D14): a host that is no tenant's is a 404, a session works only
 * on the host of a tenant its account belongs to, a login or an invitation for another tenant
 * fails exactly as an unknown one does, and a vendor on two rosters sees only the host's.
 *
 * Hosts under `.localhost` so no resolver is involved; `inject` carries the `Host` header.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashPassword, type AuditActor } from '@cat-tool/core';
import {
  addRosterMembership,
  addVendor,
  createAccount,
  getTenantForAccount,
  grantProjectAuthorization,
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

const SETUP: AuditActor = { actor: { kind: 'system', name: 'test-setup' }, label: null };
const BASE = 'platform.localhost';
const HOST_A = `alpha.${BASE}`;
const HOST_B = `beta.${BASE}`;

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;
let bare: FastifyInstance; // the same files, no base domain: how the platform ran before D14
let alice: Account; // admin of tenant A
let carol: Account; // admin of tenant B
let erin: Account; // a vendor on both rosters
let tenantA: Tenant;
let tenantB: Tenant;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-hosts-'));
  config = {
    port: 0,
    dbPath: join(dir, 'platform.sqlite'),
    storageRoot: join(dir, 'storage'),
    baseDomain: BASE,
  };
  const platform = openPlatformDb(config.dbPath);
  const make = (name: string, role?: 'vendor') =>
    createAccount(platform, {
      email: `${name}@example.com`,
      passwordHash: hashPassword(`${name}-pw`),
      actor: SETUP,
      ...(role ? { role } : {}),
    });
  make('bob', 'vendor'); // made first so no tenant id equals its founder's account id
  alice = make('alice');
  carol = make('carol');
  erin = make('erin', 'vendor');
  tenantA = getTenantForAccount(platform, alice.id)!.tenant;
  tenantB = getTenantForAccount(platform, carol.id)!.tenant;
  setTenantSlug(platform, { tenantId: tenantA.id, slug: 'alpha', actor: SETUP });
  setTenantSlug(platform, { tenantId: tenantB.id, slug: 'beta', actor: SETUP });
  for (const tenant of [tenantA, tenantB]) {
    addRosterMembership(platform, { tenantId: tenant.id, accountId: erin.id });
    const roster = openOrCreateRoster(config.storageRoot, tenant);
    addVendor(roster, { accountId: erin.id, displayName: 'Erin', actor: SETUP });
    roster.close();
  }
  platform.close();
  app = await buildApp({ config, logger: false });
  bare = await buildApp({ config: { ...config, baseDomain: undefined }, logger: false });
});

afterEach(async () => {
  await app.close();
  await bare.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const at = (host: string, token?: string) => ({
  host,
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

async function login(host: string, name: string) {
  return app.inject({
    method: 'POST',
    url: '/api/login',
    headers: at(host),
    payload: { email: `${name}@example.com`, password: `${name}-pw` },
  });
}
const tokenOf = (res: { json: () => unknown }) => (res.json() as { token: string }).token;

const loginEvents = () => {
  const platform = openPlatformDb(config.dbPath);
  try {
    return platform
      .prepare(
        "SELECT action, tenant_id AS tenantId, detail FROM audit_event WHERE action = 'auth.login_failed' ORDER BY id",
      )
      .all() as Array<{ action: string; tenantId: number | null; detail: string }>;
  } finally {
    platform.close();
  }
};

describe('a host that is no tenant’s', () => {
  it('is a 404 that names nothing: the apex, an unknown slug, a foreign domain, a deeper label', async () => {
    for (const host of [
      BASE,
      `nobody.${BASE}`,
      'alpha.example.org',
      `x.alpha.${BASE}`,
      `www.${BASE}`,
    ]) {
      for (const url of ['/api/login', '/api/me', '/']) {
        const res = await app.inject({ method: 'POST', url, headers: at(host) });
        expect(res.statusCode, `${host} ${url}`).toBe(404);
        expect(res.json()).toEqual({ error: 'not found' });
      }
    }
  });

  it('accepts a port and letter case on a real tenant’s host', async () => {
    const res = await login(`ALPHA.${BASE}:3400`, 'alice');
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('login on a tenant’s host', () => {
  it('admits its staff, and refuses another tenant’s staff exactly as a wrong password', async () => {
    const ok = await login(HOST_A, 'alice');
    expect(ok.statusCode, ok.body).toBe(200);
    const foreign = await login(HOST_A, 'carol');
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: at(HOST_A),
      payload: { email: 'alice@example.com', password: 'nope' },
    });
    expect(foreign.statusCode).toBe(401);
    expect(foreign.json()).toEqual(wrong.json());
    expect(foreign.headers['content-length']).toBe(wrong.headers['content-length']);
  });

  it('logs the refusal as not on this host, about that tenant, in the log and not the response', async () => {
    await login(HOST_A, 'carol');
    const events = loginEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.tenantId).toBe(tenantA.id);
    expect(events[0]!.detail).toContain('not_on_this_host');
  });

  it('admits a vendor on that tenant’s roster, on either of its hosts, and no other vendor', async () => {
    expect((await login(HOST_A, 'erin')).statusCode).toBe(200);
    expect((await login(HOST_B, 'erin')).statusCode).toBe(200);
    expect((await login(HOST_A, 'bob')).statusCode).toBe(401);
  });

  it('is unchanged without a base domain: anyone signs in anywhere, as before', async () => {
    const res = await bare.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email: 'carol@example.com', password: 'carol-pw' },
    });
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('a session belongs to its host', () => {
  it('works on a host of a tenant its account belongs to, and is refused as expired on another', async () => {
    const token = tokenOf(await login(HOST_A, 'alice'));
    const here = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: at(HOST_A, token),
    });
    expect(here.statusCode, here.body).toBe(200);
    const there = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: at(HOST_B, token),
    });
    expect(there.statusCode).toBe(401);
    expect(there.json()).toEqual({ error: 'invalid, missing, or expired session' });
    // the same token is valid on the bare platform: the pin is the host's, not a revocation
    const bareMe = await bare.inject({
      method: 'GET',
      url: '/api/me',
      headers: at('anything', token),
    });
    expect(bareMe.statusCode).toBe(200);
  });

  it('lets a vendor on two rosters use one session on both hosts', async () => {
    const token = tokenOf(await login(HOST_A, 'erin'));
    const onB = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: at(HOST_B, token),
    });
    expect(onB.statusCode, onB.body).toBe(200);
  });
});

describe('a vendor on two rosters sees only the host’s', () => {
  const rosters = async (a: FastifyInstance, host: string, token: string) =>
    (
      (
        await a.inject({
          method: 'GET',
          url: '/api/vendor/capacity',
          headers: at(host, token),
        })
      ).json() as { rosters: Array<{ tenantId: number }> }
    ).rosters.map((r) => r.tenantId);

  it('lists both on the bare platform and one on a tenant’s host', async () => {
    const token = tokenOf(await login(HOST_A, 'erin'));
    expect((await rosters(bare, 'x', token)).sort()).toEqual(
      [tenantA.id, tenantB.id].sort(),
    );
    expect(await rosters(app, HOST_A, token)).toEqual([tenantA.id]);
    expect(await rosters(app, HOST_B, token)).toEqual([tenantB.id]);
  });

  it('cannot name the other tenant with ?tenant= on a host, though it can on the bare platform', async () => {
    const token = tokenOf(await login(HOST_A, 'erin'));
    const url = `/api/assignments?tenant=${tenantB.id}`;
    const onBare = await bare.inject({ method: 'GET', url, headers: at('x', token) });
    expect(onBare.statusCode, onBare.body).toBe(200);
    const onHost = await app.inject({ method: 'GET', url, headers: at(HOST_A, token) });
    expect(onHost.statusCode).toBe(404);
    const own = await app.inject({
      method: 'GET',
      url: `/api/assignments?tenant=${tenantA.id}`,
      headers: at(HOST_A, token),
    });
    expect(own.statusCode, own.body).toBe(200);
  });

  it('cannot open a project another tenant granted her by ?tenant= on a host, though it opens on the bare platform', async () => {
    const carolToken = tokenOf(await login(HOST_B, 'carol'));
    const made = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: at(HOST_B, carolToken),
      payload: { name: 'job', srcLang: 'en', tgtLang: 'de' },
    });
    expect(made.statusCode, made.body).toBe(201);
    const platform = openPlatformDb(config.dbPath);
    grantProjectAuthorization(platform, {
      accountId: erin.id,
      project: { tenantId: tenantB.id, name: 'job' },
      scope: 'assigned_translator',
      actor: SETUP,
    });
    platform.close();
    const token = tokenOf(await login(HOST_A, 'erin'));
    const url = `/api/projects/job?tenant=${tenantB.id}`;
    const onBare = await bare.inject({ method: 'GET', url, headers: at('x', token) });
    expect(onBare.statusCode, onBare.body).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url, headers: at(HOST_A, token) })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url, headers: at(HOST_B, token) })).statusCode,
    ).toBe(200);
  });
});

describe('invitations on a tenant’s host', () => {
  async function inviteVendor(email: string) {
    const token = tokenOf(await login(HOST_A, 'alice'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/invitations',
      headers: at(HOST_A, token),
      payload: { email },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { token: string }).token;
  }

  it('opens and accepts a link on the host that made it, and signs the new vendor in there', async () => {
    const link = await inviteVendor('newvendor@example.com');
    const opened = await app.inject({
      method: 'POST',
      url: '/api/invitations/open',
      headers: at(HOST_A),
      payload: { token: link },
    });
    expect(opened.statusCode, opened.body).toBe(200);
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/invitations/accept',
      headers: at(HOST_A),
      payload: { token: link, password: 'a long enough password' },
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: at(HOST_A, tokenOf(accepted)),
    });
    expect(me.statusCode).toBe(200);
  });

  it('answers another tenant’s link, on open and accept, as it answers a link that does not exist', async () => {
    const link = await inviteVendor('newvendor@example.com');
    for (const [path, extra] of [
      ['/api/invitations/open', {}],
      ['/api/invitations/accept', { password: 'a long enough password' }],
    ] as const) {
      const foreign = await app.inject({
        method: 'POST',
        url: path,
        headers: at(HOST_B),
        payload: { token: link, ...extra },
      });
      const unknown = await app.inject({
        method: 'POST',
        url: path,
        headers: at(HOST_B),
        payload: { token: 'no-such-link', ...extra },
      });
      expect(foreign.statusCode, path).toBe(404);
      expect(foreign.json()).toEqual(unknown.json());
    }
    // and the refused accept consumed nothing: the link still works on its own host
    const ok = await app.inject({
      method: 'POST',
      url: '/api/invitations/open',
      headers: at(HOST_A),
      payload: { token: link },
    });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('pins a staff link the same way', async () => {
    const adminToken = tokenOf(await login(HOST_A, 'alice'));
    const made = await app.inject({
      method: 'POST',
      url: '/api/staff/invitations',
      headers: at(HOST_A, adminToken),
      payload: { email: 'newstaff@example.com', role: 'pm' },
    });
    expect(made.statusCode, made.body).toBe(201);
    const link = (made.json() as { token: string }).token;
    const foreign = await app.inject({
      method: 'POST',
      url: '/api/staff-invitations/open',
      headers: at(HOST_B),
      payload: { token: link },
    });
    expect(foreign.statusCode).toBe(404);
    const own = await app.inject({
      method: 'POST',
      url: '/api/staff-invitations/open',
      headers: at(HOST_A),
      payload: { token: link },
    });
    expect(own.statusCode, own.body).toBe(200);
  });

  describe('a vendor who already has an account joins a second tenant from its host', () => {
    // a vendor on tenant B's roster only, invited by tenant A
    let frank: Account;
    beforeEach(() => {
      const platform = openPlatformDb(config.dbPath);
      frank = createAccount(platform, {
        email: 'frank@example.com',
        passwordHash: hashPassword('frank-pw'),
        actor: SETUP,
        role: 'vendor',
      });
      addRosterMembership(platform, { tenantId: tenantB.id, accountId: frank.id });
      platform.close();
    });

    const join = (host: string, token: string, password: string) =>
      app.inject({
        method: 'POST',
        url: '/api/invitations/join-signin',
        headers: at(host),
        payload: { token, email: 'frank@example.com', password },
      });

    it('is refused for a login he cannot sign into, then joins with his own password and lands signed in', async () => {
      expect((await login(HOST_A, 'frank')).statusCode).toBe(401); // not on A's roster yet
      const link = await inviteVendor('frank@example.com');
      const wrong = await join(HOST_A, link, 'nope');
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json()).toEqual({ error: 'invalid email or password' });
      const joined = await join(HOST_A, link, 'frank-pw');
      expect(joined.statusCode, joined.body).toBe(201);
      const me = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: at(HOST_A, tokenOf(joined)),
      });
      expect(me.statusCode, me.body).toBe(200);
      expect((await login(HOST_A, 'frank')).statusCode).toBe(200);
      // the link is used: a second go is the one identical 404
      expect((await join(HOST_A, link, 'frank-pw')).statusCode).toBe(404);
    });

    it('is the one 404 for another tenant’s link, and a wrong password logs a failed login about this host', async () => {
      const link = await inviteVendor('frank@example.com');
      expect((await join(HOST_B, link, 'frank-pw')).statusCode).toBe(404);
      await join(HOST_A, link, 'nope');
      const events = loginEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.tenantId).toBe(tenantA.id);
      expect(events[0]!.detail).toContain('wrong_password');
    });

    it('never attaches an account the link was not made for', async () => {
      const link = await inviteVendor('frank@example.com');
      const res = await app.inject({
        method: 'POST',
        url: '/api/invitations/join-signin',
        headers: at(HOST_A),
        payload: { token: link, email: 'erin@example.com', password: 'erin-pw' },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
