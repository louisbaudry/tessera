/**
 * The draft engine's consent and the gate through Fastify's `inject` (backlog
 * #133; translation-engine-spec D3, D4, D8, D19): a client sends nothing until
 * its owner consents per engine, a project can narrow but never widen, every
 * change is audited with the session's actor, and nobody but an owner reaches
 * any of it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashPassword, type AuditActor } from '@cat-tool/core';
import {
  createAccount,
  grantProjectAuthorization,
  listEvents,
  openPlatformDb,
  openProjectDb,
  type Account,
} from '@cat-tool/db';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';
import { tenantOf } from './tenant.fixture.js';
import { engineFor } from './engine.js';
import { projectPath } from './storage.js';

const SETUP: AuditActor = { actor: { kind: 'system', name: 'test-setup' }, label: null };

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;
let alice: Account; // an owner
let bob: Account; // a vendor, granted on alice's `job`
let carol: Account; // another owner

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-engine-'));
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
  platform.close();
  app = await buildApp({ config, logger: false });
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const as = (token: string) => ({ authorization: `Bearer ${token}` });

async function login(name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email: `${name}@example.com`, password: `${name}-pw` },
  });
  return (res.json() as { token: string }).token;
}

const get = (token: string, url: string) =>
  app.inject({ method: 'GET', url, headers: as(token) });
const put = (token: string, url: string, payload: unknown) =>
  app.inject({ method: 'PUT', url, headers: as(token), payload: payload as object });

async function makeProject(token: string, clientId?: number): Promise<void> {
  const made = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: as(token),
    payload: { name: 'job', srcLang: 'en', tgtLang: 'es', writeTm: 'mem' },
  });
  expect(made.statusCode, made.body).toBe(201);
  if (clientId !== undefined) {
    const set = await put(token, '/api/projects/job/portal-client', { clientId });
    expect(set.statusCode, set.body).toBe(200);
  }
}

describe('a client’s consent', () => {
  it('is off for a client nobody has set up', async () => {
    const a = await login('alice');
    const res = await get(a, '/api/clients/7/engine');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ clientId: 7, default: 'off', consented: [] });
  });

  it('needs a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/clients/7/engine' });
    expect(res.statusCode).toBe(401);
  });

  it('is an owner’s to set: a vendor account is refused, and nothing is written', async () => {
    const b = await login('bob');
    expect((await get(b, '/api/clients/7/engine')).statusCode).toBe(403);
    const res = await put(b, '/api/clients/7/engine', { consent: { tessera: true } });
    expect(res.statusCode).toBe(403);
    const platform = openPlatformDb(config.dbPath);
    expect(
      listEvents(platform, { subjectType: 'client' }).filter(
        (e) => e.action === 'client_engine.changed',
      ),
    ).toEqual([]);
    platform.close();
  });

  it('consents per engine and sets a default in one request, audited with the session’s actor', async () => {
    const a = await login('alice');
    const res = await put(a, '/api/clients/7/engine', {
      consent: { tessera: true },
      default: 'tessera',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      clientId: 7,
      default: 'tessera',
      consented: ['tessera'],
    });
    const platform = openPlatformDb(config.dbPath);
    const events = listEvents(platform, { subjectType: 'client' }).filter(
      (e) => e.action === 'client_engine.changed',
    );
    expect(events.map((e) => JSON.parse(e.detail!).key)).toEqual([
      'consent:tessera',
      'default',
    ]);
    expect(events.every((e) => e.actor === `account:${alice.id}`)).toBe(true);
    platform.close();
  });

  it('refuses a default the client has not consented to', async () => {
    const a = await login('alice');
    const res = await put(a, '/api/clients/7/engine', { default: 'deepl' });
    expect(res.statusCode).toBe(400);
    expect((await get(a, '/api/clients/7/engine')).json()).toEqual({
      clientId: 7,
      default: 'off',
      consented: [],
    });
  });

  it('applies a request whole or not at all: a refused default undoes the consent beside it', async () => {
    const a = await login('alice');
    // consents to tessera, then asks for a default (deepl) it did not consent to
    const res = await put(a, '/api/clients/7/engine', {
      consent: { tessera: true },
      default: 'deepl',
    });
    expect(res.statusCode, res.body).toBe(400);
    expect((await get(a, '/api/clients/7/engine')).json()).toEqual({
      clientId: 7,
      default: 'off',
      consented: [],
    });
    const platform = openPlatformDb(config.dbPath);
    expect(
      listEvents(platform, { subjectType: 'client' }).filter(
        (e) => e.action === 'client_engine.changed',
      ),
    ).toEqual([]);
    platform.close();
  });

  it('refuses nonsense in the body, without half-applying it', async () => {
    const a = await login('alice');
    for (const body of [
      { consent: { claude: true } },
      { consent: { tessera: 'yes' } },
      { consent: [] },
      { default: 'claude' },
    ]) {
      const res = await put(a, '/api/clients/7/engine', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await put(a, '/api/clients/0/engine', {})).statusCode).toBe(400);
    expect((await get(a, '/api/clients/abc/engine')).statusCode).toBe(400);
    expect((await get(a, '/api/clients/7/engine')).json()).toEqual({
      clientId: 7,
      default: 'off',
      consented: [],
    });
  });

  it('keeps one owner’s client number apart from another’s', async () => {
    const a = await login('alice');
    const c = await login('carol');
    await put(a, '/api/clients/7/engine', { consent: { tessera: true } });
    expect((await get(c, '/api/clients/7/engine')).json()).toEqual({
      clientId: 7,
      default: 'off',
      consented: [],
    });
  });
});

describe('a project’s engine and the gate', () => {
  it('is off for a project with no client, whatever the owner consented to elsewhere', async () => {
    const a = await login('alice');
    await put(a, '/api/clients/7/engine', {
      consent: { tessera: true },
      default: 'tessera',
    });
    await makeProject(a);
    const res = await get(a, '/api/projects/job/engine');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      override: null,
      effective: { engine: 'off', reason: 'no_client' },
    });
  });

  it('inherits the client’s default once the project names the client', async () => {
    const a = await login('alice');
    await put(a, '/api/clients/7/engine', {
      consent: { tessera: true },
      default: 'tessera',
    });
    await makeProject(a, 7);
    expect((await get(a, '/api/projects/job/engine')).json()).toEqual({
      override: null,
      effective: { engine: 'tessera' },
    });
  });

  it('is off for a client that consented to nothing, and an override cannot change that', async () => {
    const a = await login('alice');
    await makeProject(a, 7);
    for (const override of ['tessera', 'deepl']) {
      const res = await put(a, '/api/projects/job/engine', { override });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({
        override,
        effective: { engine: 'off', reason: 'not_consented' },
      });
    }
  });

  it('never widens: an override to an engine the client did not consent to stays off', async () => {
    const a = await login('alice');
    await put(a, '/api/clients/7/engine', {
      consent: { tessera: true },
      default: 'tessera',
    });
    await makeProject(a, 7);
    const res = await put(a, '/api/projects/job/engine', { override: 'deepl' });
    expect(res.json()).toEqual({
      override: 'deepl',
      effective: { engine: 'off', reason: 'not_consented' },
    });
  });

  it('narrows: an override can turn it off, and inherit takes it back', async () => {
    const a = await login('alice');
    await put(a, '/api/clients/7/engine', {
      consent: { tessera: true, deepl: true },
      default: 'tessera',
    });
    await makeProject(a, 7);
    expect(
      (await put(a, '/api/projects/job/engine', { override: 'off' })).json(),
    ).toEqual({
      override: 'off',
      effective: { engine: 'off', reason: 'project_off' },
    });
    expect(
      (await put(a, '/api/projects/job/engine', { override: 'deepl' })).json(),
    ).toEqual({
      override: 'deepl',
      effective: { engine: 'deepl' },
    });
    expect(
      (await put(a, '/api/projects/job/engine', { override: 'inherit' })).json(),
    ).toEqual({ override: null, effective: { engine: 'tessera' } });
  });

  it('stops at once when the client withdraws consent', async () => {
    const a = await login('alice');
    await put(a, '/api/clients/7/engine', {
      consent: { tessera: true },
      default: 'tessera',
    });
    await makeProject(a, 7);
    await put(a, '/api/clients/7/engine', { consent: { tessera: false } });
    expect((await get(a, '/api/projects/job/engine')).json()).toEqual({
      override: null,
      effective: { engine: 'off', reason: 'client_default_off' },
    });
  });

  it('refuses a value that is not an override', async () => {
    const a = await login('alice');
    await makeProject(a, 7);
    for (const override of ['claude', '', null, 3]) {
      const res = await put(a, '/api/projects/job/engine', { override });
      expect(res.statusCode, String(override)).toBe(400);
    }
  });

  it('logs an override change in the project’s own log, under the session’s actor', async () => {
    const a = await login('alice');
    await makeProject(a, 7);
    await put(a, '/api/projects/job/engine', { override: 'off' });
    const db = openProjectDb(
      projectPath(config.storageRoot, tenantOf(config, alice), 'job'),
    );
    try {
      const events = listEvents(db, { subjectType: 'project' }).filter(
        (e) =>
          e.action === 'project.setting_changed' &&
          JSON.parse(e.detail!).key === 'engine_override',
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.actor).toBe(`account:${alice.id}`);
    } finally {
      db.close();
    }
  });

  it('is invisible to whoever does the work: a granted translator is refused, not shown', async () => {
    const a = await login('alice');
    const b = await login('bob');
    await put(a, '/api/clients/7/engine', {
      consent: { tessera: true },
      default: 'tessera',
    });
    await makeProject(a, 7);
    const platform = openPlatformDb(config.dbPath);
    grantProjectAuthorization(platform, {
      accountId: bob.id,
      project: { tenantId: tenantOf(config, alice).id, name: 'job' },
      scope: 'assigned_translator',
      actor: SETUP,
    });
    platform.close();
    const q = `?tenant=${tenantOf(config, alice).id}`;
    // A vendor account is not an owner at all, and a grantee's scope lacks `manage`.
    expect((await get(b, `/api/projects/job/engine${q}`)).statusCode).toBe(403);
    expect(
      (await put(b, `/api/projects/job/engine${q}`, { override: 'tessera' })).statusCode,
    ).toBe(403);
    // …and the project a grantee can read says nothing of an engine.
    const view = await get(b, `/api/projects/job${q}`);
    expect(view.statusCode).toBe(200);
    expect(view.body).not.toMatch(/tessera|deepl|engine/i);
  });

  it('is a 404, the same as a missing project, for a project nobody granted', async () => {
    const a = await login('alice');
    const c = await login('carol');
    await makeProject(a, 7);
    const res = await get(
      c,
      `/api/projects/job/engine?tenant=${tenantOf(config, alice).id}`,
    );
    expect(res.statusCode).toBe(404);
  });
});

describe('engineFor, the gate later slices call', () => {
  it('answers from the two files, failing closed on a missing client row', async () => {
    const a = await login('alice');
    await makeProject(a, 7);
    const platform = openPlatformDb(config.dbPath);
    const db = openProjectDb(
      projectPath(config.storageRoot, tenantOf(config, alice), 'job'),
    );
    try {
      expect(engineFor(platform, alice.id, db)).toEqual({
        engine: 'off',
        reason: 'client_default_off',
      });
      // another owner's consent for the same number does not count
      expect(engineFor(platform, carol.id, db)).toEqual({
        engine: 'off',
        reason: 'client_default_off',
      });
    } finally {
      db.close();
      platform.close();
    }
  });
});
