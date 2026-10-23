/**
 * A tenant, not an account, is what owns the files (`planning/tenant-spec.md` D6,
 * §6; backlog #205), through Fastify's `inject`: two staff of one tenant share its
 * projects and memories, a stranger from another tenant learns nothing, a vendor has
 * no tenant, and a grant is addressed by tenant id.
 *
 * The accounts are made so that **no tenant id equals its founder's account id**
 * (alice 1 / tenant 1, bob the vendor 2, carol 3 / tenant 2, dave 4 / joins tenant 1),
 * so a route that kept using the account id fails here rather than passing by luck.
 */

import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashPassword, type AuditActor } from '@cat-tool/core';
import {
  createAccount,
  getTenantForAccount,
  grantProjectAuthorization,
  openPlatformDb,
  type Account,
  type Tenant,
} from '@cat-tool/db';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';

const SETUP: AuditActor = { actor: { kind: 'system', name: 'test-setup' }, label: null };

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;
let alice: Account; // staff of tenant A
let bob: Account; // a vendor: no tenant
let carol: Account; // staff of tenant B
let dave: Account; // a second staff member of tenant A
let tenantA: Tenant;
let tenantB: Tenant;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-tenancy-'));
  config = {
    port: 0,
    dbPath: join(dir, 'platform.sqlite'),
    storageRoot: join(dir, 'storage'),
  };
  const platform = openPlatformDb(config.dbPath);
  const make = (name: string, role?: 'vendor') =>
    createAccount(platform, {
      email: `${name}@example.com`,
      passwordHash: hashPassword(`${name}-pw`),
      actor: SETUP,
      ...(role ? { role } : {}),
    });
  alice = make('alice');
  bob = make('bob', 'vendor');
  carol = make('carol');
  tenantA = getTenantForAccount(platform, alice.id)!.tenant;
  tenantB = getTenantForAccount(platform, carol.id)!.tenant;
  // Dave joins tenant A as staff does: his account is made with a membership, founding no tenant.
  dave = createAccount(platform, {
    email: 'dave@example.com',
    passwordHash: hashPassword('dave-pw'),
    actor: SETUP,
    joinTenant: { tenantId: tenantA.id, role: 'pm' },
  });
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

async function makeProject(token: string, name = 'job', writeTm?: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: as(token),
    payload: { name, srcLang: 'en', tgtLang: 'de', ...(writeTm ? { writeTm } : {}) },
  });
  expect(res.statusCode, res.body).toBe(201);
}

function grant(accountId: number, tenant: Tenant, name = 'job'): void {
  const platform = openPlatformDb(config.dbPath);
  try {
    grantProjectAuthorization(platform, {
      accountId,
      project: { tenantId: tenant.id, name },
      scope: 'assigned_translator',
      actor: SETUP,
    });
  } finally {
    platform.close();
  }
}

describe('the ids are not the account ids', () => {
  it('is the setup these tests rely on', () => {
    expect([alice.id, bob.id, carol.id, dave.id]).toEqual([1, 2, 3, 4]);
    expect([tenantA.id, tenantB.id]).toEqual([1, 2]);
    expect(tenantB.id).not.toBe(carol.id);
  });
});

describe('staff of one tenant', () => {
  it('share its projects, memories and storage root', async () => {
    const a = await login('alice');
    const d = await login('dave');
    await makeProject(a, 'job', 'mem');
    // a colleague, not the founder, sees and opens it
    const list = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: as(d),
    });
    expect((list.json() as Array<{ name: string }>).map((p) => p.name)).toEqual(['job']);
    expect(
      (await app.inject({ method: 'GET', url: '/api/projects/job', headers: as(d) }))
        .statusCode,
    ).toBe(200);
    const tms = await app.inject({ method: 'GET', url: '/api/tms', headers: as(d) });
    expect(JSON.stringify(tms.json())).toContain('mem');
    // and the file is under the tenant's root, the one directory a tenant has
    expect(
      existsSync(join(config.storageRoot, tenantA.storageRoot, 'projects', 'job.catdb')),
    ).toBe(true);
  });

  it('may name their own tenant explicitly', async () => {
    const a = await login('alice');
    await makeProject(a);
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/job?tenant=${tenantA.id}`,
      headers: as(a),
    });
    expect(res.statusCode).toBe(200);
  });

  it("cannot see, open or list another tenant's projects", async () => {
    const a = await login('alice');
    const c = await login('carol');
    await makeProject(a);
    const own = await app.inject({ method: 'GET', url: '/api/projects', headers: as(c) });
    expect(own.json()).toEqual([]);
    // 404 with no ?tenant=, with tenant A's id, and for a project that does not exist: one answer
    const asked = async (url: string) => {
      const res = await app.inject({ method: 'GET', url, headers: as(c) });
      return { code: res.statusCode, body: res.body };
    };
    const plain = await asked('/api/projects/job');
    const named = await asked(`/api/projects/job?tenant=${tenantA.id}`);
    const ghost = await asked(`/api/projects/ghost?tenant=${tenantA.id}`);
    const nobody = await asked('/api/projects/job?tenant=999');
    expect(plain.code).toBe(404);
    expect(named).toEqual(plain);
    expect(nobody).toEqual(plain);
    expect({ ...ghost, body: ghost.body.replace('ghost', 'job') }).toEqual(plain);
  });

  it('keep memories apart: a name that exists in one tenant is absent in the other', async () => {
    const a = await login('alice');
    const c = await login('carol');
    await makeProject(a, 'job', 'mem');
    const tms = await app.inject({ method: 'GET', url: '/api/tms', headers: as(c) });
    expect(JSON.stringify(tms.json())).not.toContain('mem');
  });

  it('keep jobs apart but share them within the tenant', async () => {
    const a = await login('alice');
    const d = await login('dave');
    const c = await login('carol');
    const form = new FormData();
    form.append('name', 'imported');
    form.append(
      'file',
      new Blob([
        '<?xml version="1.0" encoding="UTF-8"?><tmx version="1.4"><header srclang="en" segtype="sentence" datatype="plaintext" adminlang="en" creationtool="t" creationtoolversion="1" o-tmf="t"/><body><tu><tuv xml:lang="en"><seg>Hello</seg></tuv><tuv xml:lang="de"><seg>Hallo</seg></tuv></tu></body></tmx>',
      ]),
      'mem.tmx',
    );
    const started = await app.inject({
      method: 'POST',
      url: '/api/tms',
      headers: as(a),
      payload: form,
    });
    expect(started.statusCode, started.body).toBe(202);
    const jobId = (started.json() as { job: { id: string } }).job.id;
    // a colleague polls the job alice started; a stranger from another tenant gets "no such job"
    const mine = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}`,
      headers: as(d),
    });
    expect(mine.statusCode).toBe(200);
    const listed = await app.inject({ method: 'GET', url: '/api/jobs', headers: as(d) });
    expect(
      (listed.json() as { jobs: Array<{ id: string }> }).jobs.map((j) => j.id),
    ).toContain(jobId);
    const stranger = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}`,
      headers: as(c),
    });
    expect(stranger.statusCode).toBe(404);
    const strangerList = await app.inject({
      method: 'GET',
      url: '/api/jobs',
      headers: as(c),
    });
    expect((strangerList.json() as { jobs: unknown[] }).jobs).toEqual([]);
    const cancel = await app.inject({
      method: 'DELETE',
      url: `/api/jobs/${jobId}`,
      headers: as(c),
    });
    expect(cancel.statusCode).toBe(404);
  });
});

describe('a vendor has no tenant', () => {
  it('has no projects, memories, glossaries or jobs, as its empty storage root always said', async () => {
    const b = await login('bob');
    expect(
      (await app.inject({ method: 'GET', url: '/api/me', headers: as(b) })).statusCode,
    ).toBe(200);
    for (const url of ['/api/projects', '/api/tms', '/api/glossaries']) {
      const res = await app.inject({ method: 'GET', url, headers: as(b) });
      expect(res.statusCode, url).toBe(200);
      expect(res.json(), url).toEqual([]);
    }
    expect(
      (await app.inject({ method: 'GET', url: '/api/jobs', headers: as(b) })).json(),
    ).toEqual({
      jobs: [],
    });
    // a project route is the 404 of a project that does not exist, whether or not it does
    const a = await login('alice');
    await makeProject(a);
    for (const name of ['job', 'ghost']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${name}`,
        headers: as(b),
      });
      expect(res.statusCode, name).toBe(404);
    }
  });

  it('cannot create anything: it owns nothing to put it in (403), and nothing is written', async () => {
    const b = await login('bob');
    const made = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: as(b),
      payload: { name: 'mine', srcLang: 'en', tgtLang: 'de' },
    });
    expect(made.statusCode).toBe(403);
    expect(made.json()).toEqual({ error: expect.stringMatching(/tenant/) });
    for (const [url, payload] of [
      ['/api/tms', { name: 'mem' }],
      ['/api/glossaries', { name: 'terms' }],
    ] as const) {
      const res = await app.inject({ method: 'POST', url, headers: as(b), payload });
      expect(res.statusCode, url).toBe(403);
    }
    expect(existsSync(join(config.storageRoot, bob.storageRoot))).toBe(false);
  });
});

describe('a grant names the tenant', () => {
  it('opens one project of that tenant by its tenant id, and by nothing else', async () => {
    const c = await login('carol');
    const b = await login('bob');
    await makeProject(c);
    grant(bob.id, tenantB);
    const ok = await app.inject({
      method: 'GET',
      url: `/api/projects/job?tenant=${tenantB.id}`,
      headers: as(b),
    });
    expect(ok.statusCode, ok.body).toBe(200);
    // carol's account id is 3, her tenant's is 2: the account id names no tenant that granted
    const byAccount = await app.inject({
      method: 'GET',
      url: `/api/projects/job?tenant=${carol.id}`,
      headers: as(b),
    });
    expect(byAccount.statusCode).toBe(404);
    // and the old query name opens nothing
    const old = await app.inject({
      method: 'GET',
      url: `/api/projects/job?owner=${carol.id}`,
      headers: as(b),
    });
    expect(old.statusCode).not.toBe(200);
  });

  it('is not reachable by a stranger staff member of another tenant', async () => {
    const c = await login('carol');
    const a = await login('alice');
    await makeProject(c);
    grant(bob.id, tenantB); // bob, not alice, was granted
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/job?tenant=${tenantB.id}`,
      headers: as(a),
    });
    expect(res.statusCode).toBe(404);
  });
});
