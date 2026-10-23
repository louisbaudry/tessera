/**
 * A tenant's staff over HTTP (backlog #206, `planning/tenant-spec.md` D5, §6): the admin
 * manages staff, the pm does the work and is refused the admin's routes, a link joins
 * only the tenant that made it, and a vendor, who has no tenant, is shown nothing and
 * refused where it would create.
 *
 * As in `tenancy.test.ts` the accounts are made so no tenant id equals its founder's
 * account id (a vendor is made first).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashPassword, type AuditActor } from '@cat-tool/core';
import {
  createAccount,
  getTenantForAccount,
  openPlatformDb,
  type Account,
  type Tenant,
} from '@cat-tool/db';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';

const SETUP: AuditActor = { actor: { kind: 'system', name: 'test-setup' }, label: null };
const LONG_PASSWORD = 'a long enough password';

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;
let alice: Account; // admin of tenant A
let carol: Account; // admin of tenant B
let dave: Account; // pm of tenant A
let tenantA: Tenant;
let tenantB: Tenant;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-staff-'));
  config = {
    port: 0,
    dbPath: join(dir, 'platform.sqlite'),
    storageRoot: join(dir, 'storage'),
  };
  const platform = openPlatformDb(config.dbPath);
  const make = (name: string, extra: Partial<Parameters<typeof createAccount>[1]> = {}) =>
    createAccount(platform, {
      email: `${name}@example.com`,
      passwordHash: hashPassword(`${name}-pw`),
      actor: SETUP,
      ...extra,
    });
  make('bob', { role: 'vendor' }); // a vendor: no tenant, made first
  alice = make('alice');
  carol = make('carol');
  tenantA = getTenantForAccount(platform, alice.id)!.tenant;
  tenantB = getTenantForAccount(platform, carol.id)!.tenant;
  dave = make('dave', { joinTenant: { tenantId: tenantA.id, role: 'pm' } });
  platform.close();
  app = await buildApp({ config, logger: false });
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

async function login(name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email: `${name}@example.com`, password: `${name}-pw` },
  });
  return (res.json() as { token: string }).token;
}
const as = (token: string) => ({ authorization: `Bearer ${token}` });

async function invite(token: string, email: string, role: string) {
  return app.inject({
    method: 'POST',
    url: '/api/staff/invitations',
    headers: as(token),
    payload: { email, role },
  });
}

async function joinAs(adminToken: string, email: string, role: string): Promise<string> {
  const made = await invite(adminToken, email, role);
  expect(made.statusCode, made.body).toBe(201);
  const { token } = made.json() as { token: string };
  const res = await app.inject({
    method: 'POST',
    url: '/api/staff-invitations/accept',
    payload: { token, password: LONG_PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { token: string }).token;
}

describe('a pm does the work and is refused the admin’s routes', () => {
  it('is refused the staff routes, engine consent and webhooks with a 403', async () => {
    const pm = as(await login('dave'));
    const refused = [
      await app.inject({ method: 'GET', url: '/api/staff', headers: pm }),
      await invite(pm.authorization.slice(7), 'x@example.com', 'pm'),
      await app.inject({
        method: 'PUT',
        url: `/api/staff/${alice.id}`,
        headers: pm,
        payload: { role: 'pm' },
      }),
      await app.inject({ method: 'DELETE', url: `/api/staff/${alice.id}`, headers: pm }),
      await app.inject({
        method: 'PUT',
        url: '/api/clients/1/engine',
        headers: pm,
        payload: { consent: { tessera: true } },
      }),
      await app.inject({ method: 'GET', url: '/api/clients/1/engine', headers: pm }),
      await app.inject({ method: 'GET', url: '/api/webhooks', headers: pm }),
    ];
    for (const res of refused) {
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toEqual({ error: 'only an admin can do that' });
    }
  });

  it('still makes a project in the tenant, which an admin sees', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: as(await login('dave')),
      payload: { name: 'job', srcLang: 'en', tgtLang: 'de' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const list = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: as(await login('alice')),
    });
    expect(list.body).toContain('job');
  });

  it('is allowed by an admin where the pm is not', async () => {
    const admin = as(await login('alice'));
    expect(
      (await app.inject({ method: 'GET', url: '/api/staff', headers: admin })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/webhooks', headers: admin }))
        .statusCode,
    ).toBe(200);
    const consent = await app.inject({
      method: 'PUT',
      url: '/api/clients/1/engine',
      headers: admin,
      payload: { consent: { tessera: true } },
    });
    expect(consent.statusCode, consent.body).toBe(200);
  });
});

describe('what an account is told of its own staff role', () => {
  it('names the role an admin and a pm hold, and none for a vendor, so a screen can hide what it would refuse', async () => {
    const me = async (name: string) =>
      (
        await app.inject({
          method: 'GET',
          url: '/api/me',
          headers: as(await login(name)),
        })
      ).json() as {
        staffRole: string | null;
      };
    expect((await me('alice')).staffRole).toBe('admin');
    expect((await me('dave')).staffRole).toBe('pm');
    expect((await me('bob')).staffRole).toBeNull();
  });
});

describe('inviting staff', () => {
  it('lists staff with the caller marked, and invitations without any token', async () => {
    const admin = as(await login('alice'));
    const made = await invite(admin.authorization.slice(7), 'pat@example.com', 'pm');
    const body = made.json() as { invitation: Record<string, unknown>; token: string };
    expect(made.statusCode).toBe(201);
    expect(body.token.length).toBeGreaterThan(20);
    expect(body.invitation).toMatchObject({
      email: 'pat@example.com',
      role: 'pm',
      status: 'pending',
    });
    const list = (
      await app.inject({ method: 'GET', url: '/api/staff', headers: admin })
    ).json() as {
      staff: Array<{ accountId: number; role: string; you: boolean }>;
      invitations: Array<Record<string, unknown>>;
    };
    expect(list.staff.map((s) => [s.accountId, s.role, s.you])).toEqual([
      [alice.id, 'admin', true],
      [dave.id, 'pm', false],
    ]);
    expect(list.invitations).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(body.token);
    expect(list.invitations[0]).not.toHaveProperty('token');
  });

  it('refuses a bad role and a bad address, and a role is never taken from the link request', async () => {
    const admin = await login('alice');
    expect((await invite(admin, 'pat@example.com', 'owner')).statusCode).toBe(400);
    expect((await invite(admin, 'not an address', 'pm')).statusCode).toBe(400);
    const noRole = await app.inject({
      method: 'POST',
      url: '/api/staff/invitations',
      headers: as(admin),
      payload: { email: 'x@example.com' },
    });
    expect(noRole.statusCode).toBe(400);
  });

  it('opens to the address alone, to anyone without a session', async () => {
    const { token } = (
      await invite(await login('alice'), 'pat@example.com', 'admin')
    ).json() as { token: string };
    const open = await app.inject({
      method: 'POST',
      url: '/api/staff-invitations/open',
      payload: { token },
    });
    expect(open.statusCode).toBe(200);
    expect(open.json()).toEqual({ email: 'pat@example.com' });
    for (const bad of ['nope', '', undefined]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/staff-invitations/open',
        payload: { token: bad },
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('is the vendor’s: a vendor is shown no staff, and refused where it would invite', async () => {
    const vendor = as(await login('bob'));
    const list = await app.inject({ method: 'GET', url: '/api/staff', headers: vendor });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ staff: [], invitations: [] });
    expect(
      (await invite(vendor.authorization.slice(7), 'x@example.com', 'pm')).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/staff/${alice.id}`,
          headers: vendor,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/staff/${alice.id}`,
          headers: vendor,
          payload: { role: 'pm' },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('accepting a link', () => {
  it('joins the inviting tenant in the invited role: the new staff member sees its projects and no other tenant’s', async () => {
    const admin = await login('alice');
    const other = await login('carol');
    for (const [token, name] of [
      [admin, 'a-job'],
      [other, 'b-job'],
    ] as const) {
      const created = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: as(token),
        payload: { name, srcLang: 'en', tgtLang: 'de' },
      });
      expect(created.statusCode, created.body).toBe(201);
    }
    const pat = await joinAs(admin, 'pat@example.com', 'pm');
    const list = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: as(pat),
    });
    expect(list.body).toContain('a-job');
    expect(list.body).not.toContain('b-job');
    // a pm: the work, not the admin's routes
    expect(
      (await app.inject({ method: 'GET', url: '/api/staff', headers: as(pat) }))
        .statusCode,
    ).toBe(403);
    const platform = openPlatformDb(config.dbPath);
    try {
      const patAccount = platform
        .prepare('SELECT id FROM account WHERE email = ?')
        .get('pat@example.com') as { id: number };
      expect(getTenantForAccount(platform, patAccount.id)).toMatchObject({
        tenant: tenantA,
        role: 'pm',
      });
      // joining is not founding
      expect(
        (platform.prepare('SELECT COUNT(*) AS n FROM tenant').get() as { n: number }).n,
      ).toBe(2);
    } finally {
      platform.close();
    }
  });

  it('makes an admin who can manage staff in turn', async () => {
    const sam = await joinAs(await login('alice'), 'sam@example.com', 'admin');
    expect(
      (await app.inject({ method: 'GET', url: '/api/staff', headers: as(sam) }))
        .statusCode,
    ).toBe(200);
  });

  it('is single-use, and an address that already has an account is refused with the link left pending', async () => {
    const admin = await login('alice');
    const { token } = (await invite(admin, 'pat@example.com', 'pm')).json() as {
      token: string;
    };
    const accept = () =>
      app.inject({
        method: 'POST',
        url: '/api/staff-invitations/accept',
        payload: { token, password: LONG_PASSWORD },
      });
    expect((await accept()).statusCode).toBe(201);
    expect((await accept()).statusCode).toBe(404);

    const taken = (await invite(admin, 'carol@example.com', 'pm')).json() as {
      token: string;
    };
    const refused = await app.inject({
      method: 'POST',
      url: '/api/staff-invitations/accept',
      payload: { token: taken.token, password: LONG_PASSWORD },
    });
    expect(refused.statusCode).toBe(409);
    const open = await app.inject({
      method: 'POST',
      url: '/api/staff-invitations/open',
      payload: { token: taken.token },
    });
    expect(open.statusCode).toBe(200);
  });

  it('refuses a weak password and writes nothing', async () => {
    const { token } = (
      await invite(await login('alice'), 'pat@example.com', 'pm')
    ).json() as { token: string };
    const res = await app.inject({
      method: 'POST',
      url: '/api/staff-invitations/accept',
      payload: { token, password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    const open = await app.inject({
      method: 'POST',
      url: '/api/staff-invitations/open',
      payload: { token },
    });
    expect(open.statusCode).toBe(200);
  });

  it('is not a vendor link: the two kinds of token open only their own route', async () => {
    const { token } = (
      await invite(await login('alice'), 'pat@example.com', 'pm')
    ).json() as { token: string };
    const asVendor = await app.inject({
      method: 'POST',
      url: '/api/invitations/open',
      payload: { token },
    });
    expect(asVendor.statusCode).toBe(404);
    const vendorLink = (
      await app.inject({
        method: 'POST',
        url: '/api/invitations',
        headers: as(await login('alice')),
        payload: { email: 'v2@example.com' },
      })
    ).json() as { token: string };
    const asStaff = await app.inject({
      method: 'POST',
      url: '/api/staff-invitations/open',
      payload: { token: vendorLink.token },
    });
    expect(asStaff.statusCode).toBe(404);
  });
});

describe('withdrawing a link, changing a role, removing someone', () => {
  it('withdraws a link, and another tenant’s admin is told it does not exist', async () => {
    const admin = await login('alice');
    const made = (await invite(admin, 'pat@example.com', 'pm')).json() as {
      invitation: { id: number };
      token: string;
    };
    const stranger = await app.inject({
      method: 'POST',
      url: `/api/staff/invitations/${made.invitation.id}/revoke`,
      headers: as(await login('carol')),
    });
    expect(stranger.statusCode).toBe(404);
    const done = await app.inject({
      method: 'POST',
      url: `/api/staff/invitations/${made.invitation.id}/revoke`,
      headers: as(admin),
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ invitation: { status: 'revoked' } });
    const open = await app.inject({
      method: 'POST',
      url: '/api/staff-invitations/open',
      payload: { token: made.token },
    });
    expect(open.statusCode).toBe(404);
    // a second withdrawal is the same answer as a missing one
    const again = await app.inject({
      method: 'POST',
      url: `/api/staff/invitations/${made.invitation.id}/revoke`,
      headers: as(admin),
    });
    expect(again.statusCode).toBe(404);
  });

  it('promotes a pm, who then reaches the admin routes', async () => {
    const admin = await login('alice');
    const res = await app.inject({
      method: 'PUT',
      url: `/api/staff/${dave.id}`,
      headers: as(admin),
      payload: { role: 'admin' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/staff',
          headers: as(await login('dave')),
        })
      ).statusCode,
    ).toBe(200);
  });

  it('keeps the last admin: demoting or removing them is a 409', async () => {
    const admin = as(await login('alice'));
    const demote = await app.inject({
      method: 'PUT',
      url: `/api/staff/${alice.id}`,
      headers: admin,
      payload: { role: 'pm' },
    });
    expect(demote.statusCode).toBe(409);
    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/staff/${alice.id}`,
      headers: admin,
    });
    expect(remove.statusCode).toBe(409);
    expect(
      (await app.inject({ method: 'GET', url: '/api/staff', headers: admin })).statusCode,
    ).toBe(200);
  });

  it('refuses another tenant’s staff as a missing one, and a bad role', async () => {
    const admin = as(await login('alice'));
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/staff/${carol.id}`,
          headers: admin,
          payload: { role: 'pm' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/staff/${carol.id}`,
          headers: admin,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/staff/not-a-number',
          headers: admin,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/staff/${dave.id}`,
          headers: admin,
          payload: { role: 'owner' },
        })
      ).statusCode,
    ).toBe(400);
    // carol is still admin of tenant B
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/staff',
          headers: as(await login('carol')),
        })
      ).statusCode,
    ).toBe(200);
    expect(tenantB.id).not.toBe(carol.id);
  });

  it('ends a removed person’s session at once', async () => {
    const pm = as(await login('dave'));
    expect(
      (await app.inject({ method: 'GET', url: '/api/projects', headers: pm })).statusCode,
    ).toBe(200);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/staff/${dave.id}`,
      headers: as(await login('alice')),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/projects', headers: pm })).statusCode,
    ).toBe(401);
  });
});
