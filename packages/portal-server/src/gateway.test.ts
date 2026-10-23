/**
 * One portal per tenant (backlog #208, `planning/tenant-spec.md` D13): two tenants on one
 * server share no file, no folder, no admin, no client and no credential, and a host that
 * names no tenant gets nothing. The credential test walks every route the portal registers
 * (through `onRoute`), so a route added later is probed without anyone remembering to.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAdminUser, createClient, openPortalDb, setRate } from '@cat-tool/db';
import { hashPassword } from '@cat-tool/portal-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PortalConfig } from './config.js';
import { buildGateway, type PortalGateway } from './gateway.js';
import type { PortalTenant } from './tenants.js';

let dir: string;
let gateway: PortalGateway;
let port: number;
let tenants: PortalTenant[];
const routes: string[] = [];

const HOST_A = 'a.portal.test';
const HOST_B = 'b.portal.test';

/** Two tenants, each with its own admin (the same address, different passwords), client and rate. */
function seed(tenant: PortalTenant, label: string) {
  const db = openPortalDb(tenant.dbPath);
  createAdminUser(db, 'admin@example.com', hashPassword(`${label}-admin-pw`));
  createClient(
    db,
    `Client ${label}`,
    `client-${label}@example.com`,
    `${label}-client-token`,
  );
  setRate(db, { srcLang: 'en', tgtLang: 'es', ratePerWord: 0.1, minimumPrice: 20 });
  db.close();
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-portal-gateway-'));
  tenants = [
    {
      tenantId: 1,
      host: HOST_A,
      dbPath: join(dir, 't1', 'portal.sqlite'),
      storageRoot: join(dir, 't1', 'storage'),
    },
    {
      tenantId: 2,
      host: HOST_B,
      dbPath: join(dir, 't2', 'portal.sqlite'),
      storageRoot: join(dir, 't2', 'storage'),
    },
  ];
  const config: PortalConfig = {
    port: 0,
    dbPath: join(dir, 'unused.sqlite'),
    storageRoot: join(dir, 'unused'),
    smtp: undefined,
  };
  routes.length = 0;
  // the databases exist before the apps open them: the gateway creates the folders
  const { mkdirSync } = await import('node:fs');
  for (const t of tenants) mkdirSync(join(t.dbPath, '..'), { recursive: true });
  seed(tenants[0]!, 'a');
  seed(tenants[1]!, 'b');
  gateway = await buildGateway({
    config,
    tenants,
    logger: false,
    onRoute: (r) => routes.push(`${r.method} ${r.url}`),
  });
  port = (await gateway.listen(0, '127.0.0.1')).port;
});

afterEach(async () => {
  await gateway.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

interface Res {
  status: number;
  body: string;
}

/** A real HTTP request with a chosen `Host`, so the gateway's own routing is what answers. */
function http(
  host: string,
  method: string,
  path: string,
  init: { token?: string; json?: unknown } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const body = init.json === undefined ? undefined : JSON.stringify(init.json);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          host,
          ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
          ...(body
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function adminToken(host: string, label: string): Promise<string> {
  const res = await http(host, 'POST', '/api/admin/login', {
    json: { email: 'admin@example.com', password: `${label}-admin-pw` },
  });
  expect(res.status, res.body).toBe(200);
  return (JSON.parse(res.body) as { token: string }).token;
}

describe('a request goes to the tenant whose host it names', () => {
  it('answers each tenant’s own client and admin on its own host', async () => {
    const mine = await http(HOST_A, 'GET', '/api/client/me', { token: 'a-client-token' });
    expect(mine.status, mine.body).toBe(200);
    expect(mine.body).toContain('client-a@example.com');
    const theirs = await http(HOST_B, 'GET', '/api/client/me', {
      token: 'b-client-token',
    });
    expect(theirs.body).toContain('client-b@example.com');
    expect(
      (
        await http(HOST_A, 'GET', '/api/admin/orders', {
          token: await adminToken(HOST_A, 'a'),
        })
      ).status,
    ).toBe(200);
  });

  it('matches a host however the client wrote it: case, a port, a trailing dot', async () => {
    for (const host of ['A.Portal.Test', `${HOST_A}:${port}`, `${HOST_A}.`]) {
      const res = await http(host, 'GET', '/api/client/me', { token: 'a-client-token' });
      expect(res.status, host).toBe(200);
      expect(res.body).toContain('client-a@example.com');
    }
  });

  it('answers a host that names no tenant with a 404 that says nothing, and never falls back to one', async () => {
    const bodies = new Set<string>();
    for (const host of [
      'unknown.portal.test',
      'portal.test',
      'a.portal.test.evil.test',
      '127.0.0.1',
      'localhost',
    ]) {
      const res = await http(host, 'GET', '/api/client/me', { token: 'a-client-token' });
      expect(res.status, host).toBe(404);
      bodies.add(res.body);
      // not even the static page is served to a host nobody owns
      expect((await http(host, 'GET', '/client.html')).status, host).toBe(404);
    }
    expect([...bodies]).toEqual(['{"error":"not found"}']);
  });
});

describe('two tenants share no credential', () => {
  it('has an admin per file: the same address and another tenant’s password is refused', async () => {
    expect(
      (
        await http(HOST_B, 'POST', '/api/admin/login', {
          json: { email: 'admin@example.com', password: 'a-admin-pw' },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await http(HOST_A, 'POST', '/api/admin/login', {
          json: { email: 'admin@example.com', password: 'b-admin-pw' },
        })
      ).status,
    ).toBe(401);
  });

  it('refuses another tenant’s admin session and client link on every route the portal registers', async () => {
    const known = [
      ...new Set(
        routes.filter((r) => !r.startsWith('HEAD ') && !r.startsWith('OPTIONS ')),
      ),
    ];
    const api = known.filter((r) => r.split(' ')[1]!.startsWith('/api/'));
    const unclassified = api.filter((r) => {
      const url = r.split(' ')[1]!;
      return (
        r !== 'POST /api/admin/login' &&
        !url.startsWith('/api/admin/') &&
        !url.startsWith('/api/client/')
      );
    });
    expect(
      unclassified,
      'a new /api route must be under /api/admin or /api/client, or be classified here',
    ).toEqual([]);

    const fill = (url: string) => url.replace(/:fileId|:id/g, '1').replace(':kind', 'tm');
    const failures: string[] = [];
    let probes = 0;
    for (const route of api) {
      const [method, pattern] = route.split(' ') as [string, string];
      if (route === 'POST /api/admin/login') continue;
      const url = fill(pattern);
      // a fresh session per route: logout revokes the one it is sent with, and a token that was
      // revoked on A would be refused on B for the wrong reason
      const adminA = await adminToken(HOST_A, 'a');
      const body = method === 'GET' || method === 'DELETE' ? {} : { json: {} };
      for (const token of [adminA, 'a-client-token']) {
        const got = await http(HOST_B, method, url, { token, ...body });
        probes++;
        if (got.status !== 401)
          failures.push(
            `${route} on B with tenant A's credential: ${got.status} ${got.body.slice(0, 100)}`,
          );
      }
      // the control: the right credential on its own host reaches the handler, so a 401 above means something
      const own = url.startsWith('/api/admin/') ? adminA : 'a-client-token';
      const control = await http(HOST_A, method, url, { token: own, ...body });
      probes++;
      if (control.status === 401)
        failures.push(`${route}: the control credential was refused on its own host`);
    }
    expect(failures).toEqual([]);
    expect(probes).toBeGreaterThan(40);
  });
});

describe('two tenants share no file', () => {
  it('stores a client’s upload under its own tenant’s folder and nowhere else', async () => {
    const form = new FormData();
    form.append('srcLang', 'en');
    form.append('tgtLangs', 'es');
    form.append('files', new Blob(['hello world'], { type: 'text/plain' }), 'doc.txt');
    const res = await gateway.appFor(HOST_A)!.inject({
      method: 'POST',
      url: '/api/client/orders',
      headers: { authorization: 'Bearer a-client-token' },
      payload: form,
    });
    expect(res.statusCode, res.body).toBe(201);
    const walk = (root: string): string[] =>
      existsSync(root)
        ? readdirSync(root, { withFileTypes: true }).flatMap((e) =>
            e.isDirectory() ? walk(join(root, e.name)) : [join(root, e.name)],
          )
        : [];
    expect(walk(tenants[0]!.storageRoot)).toHaveLength(1);
    expect(walk(tenants[1]!.storageRoot)).toEqual([]);
    // and the order is in A's database only
    const orders = (host: string, token: string) =>
      http(host, 'GET', '/api/client/orders', { token });
    expect(JSON.parse((await orders(HOST_A, 'a-client-token')).body)).toHaveLength(1);
    expect(JSON.parse((await orders(HOST_B, 'b-client-token')).body)).toHaveLength(0);
  });
});

describe('the legacy single portal', () => {
  it('answers every host with its one app, as the portal always has', async () => {
    const solo = join(dir, 'solo');
    const config: PortalConfig = {
      port: 0,
      dbPath: join(solo, 'portal.sqlite'),
      storageRoot: join(solo, 'storage'),
      smtp: undefined,
    };
    const gw = await buildGateway({ config, logger: false });
    try {
      const db = openPortalDb(config.dbPath);
      createClient(db, 'Solo', 'solo@example.com', 'solo-token');
      db.close();
      for (const host of [undefined, 'anything.example', 'localhost:3300']) {
        const res = await gw.appFor(host)!.inject({
          method: 'GET',
          url: '/api/client/me',
          headers: { authorization: 'Bearer solo-token' },
        });
        expect(res.statusCode, String(host)).toBe(200);
      }
      expect(gw.tenants).toEqual([
        {
          tenantId: null,
          host: null,
          dbPath: config.dbPath,
          storageRoot: config.storageRoot,
        },
      ]);
    } finally {
      await gw.close();
    }
  });
});
