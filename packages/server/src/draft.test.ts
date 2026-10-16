/**
 * Starting a drafting run through Fastify's `inject` (backlog #136;
 * translation-engine-spec D4, D5, D15, D20, D26): nothing is sent for a client
 * that has not consented, a run is a job the owner polls and cancels, a consent
 * withdrawn mid-run stops it, and only an owner reaches any of it. A fake
 * adapter stands in for the network, so no test has a key or a connection.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  putDraftSuggestion,
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
let carol: Account; // another owner

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
  carol = make('carol');
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
  result: { stop: string; requested: number; stored: number; discarded: number } | null;
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

  it('says plainly when an engine has no adapter: unconfigured, it is 503 for either', async () => {
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
    expect(deepl.statusCode).toBe(503);
    expect(deepl.json()).toEqual({
      error: 'the draft engine is not configured on this server',
    });
  });

  it('the client’s default picks the engine: Tessera here (slice 6)', async () => {
    const tessera = createFakeEngine(echo, { engine: 'tessera', model: 'm-t' });
    const deepl = createFakeEngine(echo, { engine: 'deepl', model: 'deepl-v2' });
    await app.close();
    app = await buildApp({
      config,
      logger: false,
      draftAdapterFor: (engine) => (engine === 'tessera' ? tessera : deepl),
    });
    const a = await login('alice');
    await setup(a, { tessera: true, deepl: true, default: 'tessera' });

    const viaDefault = await settled(
      a,
      jobIdOf(await post(a, '/api/projects/job/draft')),
    );
    expect(viaDefault.result).toMatchObject({ stop: 'done' });
    expect(tessera.calls.length).toBeGreaterThan(0);
    expect(deepl.calls).toHaveLength(0);
    const db = projectDb();
    expect(new Set(listDraftSuggestions(db).map((s) => s.engine))).toEqual(
      new Set(['tessera']),
    );
    db.close();
  });

  it('a project override to DeepL is drafted by DeepL alone, and logged as the engine (slice 6)', async () => {
    const tessera = createFakeEngine(echo, { engine: 'tessera', model: 'm-t' });
    const deepl = createFakeEngine(echo, { engine: 'deepl', model: 'deepl-v2' });
    await app.close();
    app = await buildApp({
      config,
      logger: false,
      draftAdapterFor: (engine) => (engine === 'tessera' ? tessera : deepl),
    });
    const a = await login('alice');
    await setup(a, { tessera: true, deepl: true, default: 'tessera' });
    expect(
      (await put(a, '/api/projects/job/engine', { override: 'deepl' })).statusCode,
    ).toBe(200);

    const job = await settled(a, jobIdOf(await post(a, '/api/projects/job/draft')));
    expect(job.result).toMatchObject({ stop: 'done' });
    expect(deepl.calls.length).toBe(job.result!.requested);
    expect(tessera.calls).toHaveLength(0);
    const db = projectDb();
    expect(new Set(listDraftSuggestions(db).map((s) => s.engine))).toEqual(
      new Set(['deepl']),
    );
    const sent = listEvents(db, { subjectType: 'segment' }).filter(
      (e) => e.action === 'ai.requested',
    );
    expect(sent.length).toBe(job.result!.requested);
    expect(JSON.parse(sent[0]!.detail!)).toMatchObject({
      engine: 'deepl',
      model: 'deepl-v2',
    });
    expect(verifyAudit(db)).toMatchObject({ brokenAt: null });
    db.close();
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
    // The call that was out when consent was withdrawn is answered and thrown away:
    // D15 says nothing of an opted-out client's stays, so it is never stored.
    expect(job.result).toMatchObject({
      stop: 'gate_closed',
      requested: 1,
      stored: 0,
      discarded: 1,
    });
    expect(g.arrived()).toBe(1);
    const db = projectDb();
    expect(listDraftSuggestions(db)).toHaveLength(0);
    db.close();
  });
});

describe('withdrawing a client’s consent purges what its engine drafted (D15)', () => {
  /** A finished run for client 7: how many suggestions it left. */
  async function drafted(a: string): Promise<number> {
    await setup(a);
    const job = await settled(a, jobIdOf(await post(a, '/api/projects/job/draft')));
    return job.result!.stored;
  }

  const purgeEvents = () => {
    const db = projectDb();
    try {
      return listEvents(db, { subjectType: 'project' }).filter(
        (e) => e.action === 'draft.purged',
      );
    } finally {
      db.close();
    }
  };

  it('deletes the client’s unaccepted suggestions, logs it, and says how many', async () => {
    const a = await login('alice');
    const stored = await drafted(a);
    expect(stored).toBeGreaterThan(0);

    const res = await put(a, `/api/clients/${CLIENT}/engine`, {
      consent: { tessera: false },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      consented: [],
      purged: { removed: stored, failed: 0 },
    });

    const db = projectDb();
    expect(listDraftSuggestions(db)).toHaveLength(0);
    db.close();
    const events = purgeEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.actor).toBe(`account:${alice.id}`);
    expect(JSON.parse(events[0]!.detail!)).toEqual({
      engine: 'tessera',
      count: stored,
      reason: 'consent_withdrawn',
    });
  });

  it('leaves another client’s project, another owner’s, and another engine’s suggestions alone', async () => {
    const a = await login('alice');
    await drafted(a);
    const one = (root: Account, name: string) => {
      const db = openProjectDb(projectPath(config.storageRoot, root, name));
      const [segment] = listAllSegments(db);
      putDraftSuggestion(db, {
        segmentId: segment!.id,
        sourceHash: segment!.sourceHash,
        targetTokens: [{ t: 'text', v: 'x' }],
        engine: 'tessera',
        model: 'm',
        promptVersion: 'v',
        inputSha256: 'h',
        createdAt: '2026-10-15T00:00:00.000Z',
      });
      db.close();
    };

    // Alice's project for another client, and carol's own client 7: not the same client.
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: as(a),
      payload: { name: 'other', srcLang: 'en', tgtLang: 'es', writeTm: 'mem2' },
    });
    expect(
      (await put(a, '/api/projects/other/portal-client', { clientId: 9 })).statusCode,
    ).toBe(200);
    const db = openProjectDb(projectPath(config.storageRoot, alice, 'other'));
    insertFile(
      db,
      'prose-short.docx',
      assembleFile(new Uint8Array(readFileSync(FIXTURE)), rulesFor('en')),
      { actor: SETUP },
    );
    db.close();
    one(alice, 'other');

    const c = await login('carol');
    const carolMade = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: as(c),
      payload: { name: 'job', srcLang: 'en', tgtLang: 'es', writeTm: 'mem' },
    });
    expect(carolMade.statusCode, carolMade.body).toBe(201);
    expect(
      (await put(c, '/api/projects/job/portal-client', { clientId: CLIENT })).statusCode,
    ).toBe(200);
    const carolDb = openProjectDb(projectPath(config.storageRoot, carol, 'job'));
    insertFile(
      carolDb,
      'prose-short.docx',
      assembleFile(new Uint8Array(readFileSync(FIXTURE)), rulesFor('en')),
      { actor: SETUP },
    );
    carolDb.close();
    one(carol, 'job');

    // One deepl suggestion in alice's own client-7 project: another engine's, so it stays.
    const mine = projectDb();
    const [first] = listDraftSuggestions(mine);
    putDraftSuggestion(mine, { ...first!, engine: 'deepl' });
    mine.close();

    const res = await put(a, `/api/clients/${CLIENT}/engine`, {
      consent: { tessera: false },
    });
    expect(res.statusCode, res.body).toBe(200);

    const left = (root: Account, name: string) => {
      const d = openProjectDb(projectPath(config.storageRoot, root, name));
      try {
        return listDraftSuggestions(d).length;
      } finally {
        d.close();
      }
    };
    expect(left(alice, 'other')).toBe(1); // another client
    expect(left(carol, 'job')).toBe(1); // another owner
    expect(left(alice, 'job')).toBe(1); // the deepl one only
  });

  it('says nothing of a purge when no consent was withdrawn', async () => {
    const a = await login('alice');
    await drafted(a);
    const same = await put(a, `/api/clients/${CLIENT}/engine`, {
      consent: { tessera: true },
    });
    expect(same.json()).not.toHaveProperty('purged');
    const noop = await put(a, `/api/clients/${CLIENT}/engine`, {
      consent: { deepl: false },
    });
    expect(noop.json()).not.toHaveProperty('purged');
    expect(purgeEvents()).toHaveLength(0);
  });

  it('reports a project it could not purge instead of calling the purge done', async () => {
    const a = await login('alice');
    const stored = await drafted(a);
    // A file in the owner's projects that is not a project database at all.
    writeFileSync(projectPath(config.storageRoot, alice, 'broken'), 'not a database');

    const res = await put(a, `/api/clients/${CLIENT}/engine`, {
      consent: { tessera: false },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ purged: { removed: stored, failed: 1 } });
    const db = projectDb();
    expect(listDraftSuggestions(db)).toHaveLength(0);
    db.close();
  });
});
