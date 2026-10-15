/**
 * Starting a drafting run through Fastify's `inject` (backlog #136;
 * translation-engine-spec D4, D5, D15, D20, D26): nothing is sent for a client
 * that has not consented, a run is a job the owner polls and cancels, a consent
 * withdrawn mid-run stops it, and only an owner reaches any of it. A fake
 * adapter stands in for the network, so no test has a key or a connection.
 */

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assembleFile,
  createFakeEngine,
  hashPassword,
  rulesFor,
  type AuditActor,
  type DraftEngineAdapter,
  type DraftRequest,
  type DraftResult,
} from '@cat-tool/core';
import {
  createAccount,
  grantProjectAuthorization,
  insertFile,
  listAllSegments,
  listDraftSuggestions,
  listEvents,
  openPlatformDb,
  openProjectDb,
  verifyAudit,
  type Account,
} from '@cat-tool/db';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';
import { projectPath } from './storage.js';

const SETUP: AuditActor = { actor: { kind: 'system', name: 'test-setup' }, label: null };
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/docx/prose-short.docx',
);

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;
let alice: Account; // an owner
let bob: Account; // a vendor, granted on alice's `job`

/** The adapter every run is given; swapped per test, reset before each. */
let adapter: DraftEngineAdapter;
const echo = (req: DraftRequest) => req.sourceText;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-draft-route-'));
  config = {
    port: 0,
    dbPath: join(dir, 'platform.sqlite'),
    storageRoot: join(dir, 'storage'),
    draftModel: 'm-1',
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
  make('carol'); // another owner, who only logs in
  platform.close();
  adapter = createFakeEngine(echo, { model: 'm-1' });
  app = await buildApp({
    config,
    logger: false,
    draftAdapterFor: (engine) => (engine === 'tessera' ? adapter : null),
  });
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

const post = (token: string, url: string) =>
  app.inject({ method: 'POST', url, headers: as(token) });
const get = (token: string, url: string) =>
  app.inject({ method: 'GET', url, headers: as(token) });
const put = (token: string, url: string, payload: unknown) =>
  app.inject({ method: 'PUT', url, headers: as(token), payload: payload as object });

const CLIENT = 7;

/** A project for client 7 with a few segments in it, and consent as asked. */
async function setup(
  token: string,
  consent: { tessera?: boolean; deepl?: boolean; default?: 'tessera' | 'deepl' } = {
    tessera: true,
    default: 'tessera',
  },
): Promise<void> {
  const made = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: as(token),
    payload: { name: 'job', srcLang: 'en', tgtLang: 'es', writeTm: 'mem' },
  });
  expect(made.statusCode, made.body).toBe(201);
  const set = await put(token, '/api/projects/job/portal-client', { clientId: CLIENT });
  expect(set.statusCode, set.body).toBe(200);
  const db = openProjectDb(projectPath(config.storageRoot, alice, 'job'));
  insertFile(
    db,
    'prose-short.docx',
    assembleFile(new Uint8Array(readFileSync(FIXTURE)), rulesFor('en')),
    {
      actor: SETUP,
    },
  );
  db.close();
  const { default: defaultEngine, ...engines } = consent;
  const res = await put(token, `/api/clients/${CLIENT}/engine`, {
    consent: engines,
    ...(defaultEngine ? { default: defaultEngine } : {}),
  });
  expect(res.statusCode, res.body).toBe(200);
}

interface JobBody {
  state: string;
  result: { stop: string; requested: number; stored: number } | null;
}

async function settled(token: string, id: string): Promise<JobBody> {
  for (let i = 0; i < 500; i++) {
    const job = (await get(token, `/api/jobs/${id}`)).json() as JobBody;
    if (job.state !== 'running') return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the job never settled');
}

const jobIdOf = (res: { json(): unknown }) =>
  (res.json() as { job: { id: string } }).job.id;

const projectDb = () => openProjectDb(projectPath(config.storageRoot, alice, 'job'));

/** An adapter that waits at each call until the test lets it go. */
function gated(): DraftEngineAdapter & {
  arrived: () => number;
  release: () => void;
} {
  let arrived = 0;
  let open: () => void = () => {};
  const gate = new Promise<void>((r) => (open = r));
  return {
    engine: 'tessera',
    model: 'm-1',
    arrived: () => arrived,
    release: () => open(),
    async draft(request): Promise<DraftResult> {
      arrived++;
      await gate;
      return {
        text: request.sourceText,
        model: 'm-1',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
}

const untilArrived = async (g: { arrived: () => number }, n: number) => {
  for (let i = 0; i < 500 && g.arrived() < n; i++)
    await new Promise((r) => setTimeout(r, 10));
  expect(g.arrived()).toBeGreaterThanOrEqual(n);
};

describe('POST /api/projects/:name/draft', () => {
  it('refuses a client that has not consented, sends nothing and logs nothing', async () => {
    const a = await login('alice');
    await setup(a, {});
    const res = await post(a, '/api/projects/job/draft');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: 'client_default_off' });
    expect((adapter as ReturnType<typeof createFakeEngine>).calls).toHaveLength(0);
    const db = projectDb();
    expect(
      listEvents(db, { subjectType: 'segment' }).filter(
        (e) => e.action === 'ai.requested',
      ),
    ).toEqual([]);
    db.close();
  });

  it('runs as a job: suggestions stored, no target written, every send logged with the session’s actor', async () => {
    const a = await login('alice');
    await setup(a);
    const res = await post(a, '/api/projects/job/draft');
    expect(res.statusCode, res.body).toBe(202);
    const id = jobIdOf(res);
    expect(res.headers['location']).toBe(`/api/jobs/${id}`);

    const job = await settled(a, id);
    expect(job.state).toBe('done');
    expect(job.result).toMatchObject({ stop: 'done' });
    expect(job.result!.stored).toBeGreaterThan(0);
    expect(job.result!.stored).toBe(job.result!.requested);

    const db = projectDb();
    expect(listDraftSuggestions(db)).toHaveLength(job.result!.stored);
    expect(listAllSegments(db).every((s) => s.targetTokens === null)).toBe(true);
    const sent = listEvents(db, { subjectType: 'segment' }).filter(
      (e) => e.action === 'ai.requested',
    );
    expect(sent).toHaveLength(job.result!.requested);
    expect(sent[0]!.actor).toBe(`account:${alice.id}`);
    expect(verifyAudit(db)).toMatchObject({ brokenAt: null });
    db.close();
  });

  it('is an owner’s: a vendor, a grantee and another owner are refused, and nothing is sent', async () => {
    const a = await login('alice');
    await setup(a);
    const platform = openPlatformDb(config.dbPath);
    grantProjectAuthorization(platform, {
      accountId: bob.id,
      project: { accountId: alice.id, name: 'job' },
      scope: 'assigned_translator',
      actor: SETUP,
    });
    platform.close();
    const b = await login('bob');
    expect((await post(b, '/api/projects/job/draft')).statusCode).toBe(403);
    expect((await post(b, `/api/projects/job/draft?owner=${alice.id}`)).statusCode).toBe(
      403,
    );
    const c = await login('carol');
    expect((await post(c, '/api/projects/job/draft')).statusCode).toBe(404);
    expect((await post(c, `/api/projects/job/draft?owner=${alice.id}`)).statusCode).toBe(
      404,
    );
    expect(
      (await app.inject({ method: 'POST', url: '/api/projects/job/draft' })).statusCode,
    ).toBe(401);
    expect((adapter as ReturnType<typeof createFakeEngine>).calls).toHaveLength(0);
  });

  it('shows the job to the account that started it, and to nobody else', async () => {
    const a = await login('alice');
    await setup(a);
    const id = jobIdOf(await post(a, '/api/projects/job/draft'));
    await settled(a, id);
    const c = await login('carol');
    expect((await get(c, `/api/jobs/${id}`)).statusCode).toBe(404);
    const b = await login('bob');
    expect((await get(b, `/api/jobs/${id}`)).statusCode).toBe(404);
  });

  it('says plainly when the engine has no adapter: unconfigured Tessera is 503, DeepL 501', async () => {
    const a = await login('alice');
    await setup(a, { tessera: true, deepl: true, default: 'tessera' });
    await app.close();
    // No injected adapter and no key in the config: the deployment default.
    app = await buildApp({ config, logger: false });
    const a2 = await login('alice');
    const unconfigured = await post(a2, '/api/projects/job/draft');
    expect(unconfigured.statusCode).toBe(503);
    expect(unconfigured.json()).toEqual({
      error: 'the draft engine is not configured on this server',
    });

    expect(
      (await put(a2, '/api/projects/job/engine', { override: 'deepl' })).statusCode,
    ).toBe(200);
    const deepl = await post(a2, '/api/projects/job/draft');
    expect(deepl.statusCode).toBe(501);
  });

  it('allows one run at a time for an account, and a cancelled run ends between segments', async () => {
    const g = gated();
    adapter = g;
    const a = await login('alice');
    await setup(a);
    const first = await post(a, '/api/projects/job/draft');
    expect(first.statusCode).toBe(202);
    await untilArrived(g, 1);

    const second = await post(a, '/api/projects/job/draft');
    expect(second.statusCode).toBe(409);

    const id = jobIdOf(first);
    const asked = await app.inject({
      method: 'DELETE',
      url: `/api/jobs/${id}`,
      headers: as(a),
    });
    expect(asked.statusCode).toBe(202);
    g.release();
    const job = await settled(a, id);
    expect(job.state).toBe('cancelled');

    // Only the segment in flight when it was cancelled was asked, and it was kept.
    expect(g.arrived()).toBe(1);
    const db = projectDb();
    expect(listDraftSuggestions(db)).toHaveLength(1);
    db.close();
  });

  it('stops the rest of a run when the client’s consent is withdrawn while it runs', async () => {
    const g = gated();
    adapter = g;
    const a = await login('alice');
    await setup(a);
    const id = jobIdOf(await post(a, '/api/projects/job/draft'));
    await untilArrived(g, 1);

    const withdrawn = await put(a, `/api/clients/${CLIENT}/engine`, {
      consent: { tessera: false },
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    g.release();

    const job = await settled(a, id);
    expect(job.state).toBe('done');
    expect(job.result).toMatchObject({ stop: 'gate_closed', requested: 1, stored: 1 });
    expect(g.arrived()).toBe(1);
  });
});
