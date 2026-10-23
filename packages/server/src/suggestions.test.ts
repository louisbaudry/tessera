/**
 * What a translator reaches of the draft engine, through `inject` (backlog #138;
 * translation-engine-spec D3, D20, D34, D35): the list, asking for one segment,
 * accepting. A fake adapter stands in for the network. The translator is a vendor
 * account granted on the owner's project, because the engine is invisible to
 * exactly that person: every answer is tokens, and nothing in any answer says
 * where they came from.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
} from '@cat-tool/core';
import {
  createAccount,
  getDraftSuggestion,
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
import { tenantOf } from './tenant.fixture.js';
import { projectPath } from './storage.js';

const SETUP: AuditActor = { actor: { kind: 'system', name: 'test-setup' }, label: null };
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/docx/prose-short.docx',
);
const CLIENT = 7;

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;
let alice: Account; // the owner
let bob: Account; // the translator: a vendor account granted on alice's `job`
let adapter: DraftEngineAdapter & { calls?: readonly DraftRequest[] };

const echo = (req: DraftRequest) => req.sourceText;

async function build(adapterFor?: Parameters<typeof buildApp>[0]['draftAdapterFor']) {
  app = await buildApp({
    config,
    logger: false,
    ...(adapterFor ? { draftAdapterFor: adapterFor } : {}),
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-suggestions-'));
  config = {
    port: 0,
    dbPath: join(dir, 'platform.sqlite'),
    storageRoot: join(dir, 'storage'),
    draftModel: 'm-secret-1',
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
  make('carol');
  platform.close();
  adapter = createFakeEngine(echo, { model: 'm-secret-1' });
  await build((engine) => (engine === 'tessera' ? adapter : null));
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
const post = (token: string, url: string, payload?: unknown) =>
  app.inject({ method: 'POST', url, headers: as(token), payload: payload as object });
const put = (token: string, url: string, payload: unknown) =>
  app.inject({ method: 'PUT', url, headers: as(token), payload: payload as object });

const dbOf = () =>
  openProjectDb(projectPath(config.storageRoot, tenantOf(config, alice), 'job'));
const Q = () => `?tenant=${tenantOf(config, alice).id}`;

/** alice's project with a file, consent as asked, and bob granted as a translator. */
async function setup(consent = true): Promise<{ a: string; b: string; ids: number[] }> {
  const a = await login('alice');
  const made = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: as(a),
    payload: { name: 'job', srcLang: 'en', tgtLang: 'es', writeTm: 'mem' },
  });
  expect(made.statusCode, made.body).toBe(201);
  expect(
    (await put(a, '/api/projects/job/portal-client', { clientId: CLIENT })).statusCode,
  ).toBe(200);
  const db = dbOf();
  insertFile(
    db,
    'prose-short.docx',
    assembleFile(new Uint8Array(readFileSync(FIXTURE)), rulesFor('en')),
    { actor: SETUP },
  );
  const ids = listAllSegments(db)
    .filter((s) => !s.locked)
    .map((s) => s.id);
  db.close();
  if (consent) {
    const res = await put(a, `/api/clients/${CLIENT}/engine`, {
      consent: { tessera: true },
      default: 'tessera',
    });
    expect(res.statusCode, res.body).toBe(200);
  }
  const platform = openPlatformDb(config.dbPath);
  grantProjectAuthorization(platform, {
    accountId: bob.id,
    project: { tenantId: tenantOf(config, alice).id, name: 'job' },
    scope: 'assigned_translator',
    actor: SETUP,
  });
  platform.close();
  return { a, b: await login('bob'), ids };
}

const calls = () => (adapter as ReturnType<typeof createFakeEngine>).calls;
const sentLog = () => {
  const db = dbOf();
  try {
    return listEvents(db, { subjectType: 'segment' }).filter(
      (e) => e.action === 'ai.requested',
    );
  } finally {
    db.close();
  }
};

/** Words that would tell a translator where a suggestion came from. */
const GIVEAWAYS = [
  'tessera',
  'deepl',
  'anthropic',
  'claude',
  'm-secret-1',
  'prompt',
  'sha256',
  'engine',
  'model',
  'provenance',
];
const leaksNothing = (body: string) => {
  const lower = body.toLowerCase();
  return GIVEAWAYS.filter((w) => lower.includes(w));
};

describe('asking for a draft for the open segment', () => {
  it('drafts it, answers tokens only, and logs the translator as the one who asked', async () => {
    const { b, ids } = await setup();
    const res = await post(b, `/api/projects/job/segments/${ids[0]}/suggestion${Q()}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { tokens: unknown[] | null };
    expect(Array.isArray(body.tokens)).toBe(true);
    expect(Object.keys(body)).toEqual(['tokens']);
    expect(leaksNothing(res.body)).toEqual([]);

    expect(calls()).toHaveLength(1);
    const sent = sentLog();
    expect(sent).toHaveLength(1);
    // The accountable human: the translator who asked, never the engine or the owner.
    expect(sent[0]!.actor).toBe(`account:${bob.id}`);

    // Asked again, it answers from what is stored and sends nothing more.
    const again = await post(b, `/api/projects/job/segments/${ids[0]}/suggestion${Q()}`);
    expect(again.json()).toEqual(body);
    expect(calls()).toHaveLength(1);
  });

  it('answers the same {tokens: null} whether the engine is off, unconfigured, failing or empty-handed', async () => {
    // Off: the client never consented.
    const off = await setup(false);
    const offRes = await post(
      off.b,
      `/api/projects/job/segments/${off.ids[0]}/suggestion${Q()}`,
    );
    expect(offRes.statusCode).toBe(200);
    expect(offRes.json()).toEqual({ tokens: null });
    expect(calls()).toHaveLength(0);
    expect(sentLog()).toHaveLength(0);

    // Unconfigured: consent given, no adapter on the server.
    await app.close();
    await build(() => null);
    const a = await login('alice');
    await put(a, `/api/clients/${CLIENT}/engine`, {
      consent: { tessera: true },
      default: 'tessera',
    });
    const b = await login('bob');
    const unconfigured = await post(
      b,
      `/api/projects/job/segments/${off.ids[0]}/suggestion${Q()}`,
    );
    expect(unconfigured.statusCode).toBe(200);
    expect(unconfigured.body).toBe(offRes.body);

    // Failing: an adapter that throws.
    await app.close();
    const broken: DraftEngineAdapter = {
      engine: 'tessera',
      model: 'm-secret-1',
      draft: () =>
        Promise.reject(new Error('the draft engine answered 401 (authentication_error)')),
    };
    await build(() => broken);
    const b2 = await login('bob');
    const failing = await post(
      b2,
      `/api/projects/job/segments/${off.ids[0]}/suggestion${Q()}`,
    );
    expect(failing.statusCode).toBe(200);
    expect(failing.body).toBe(offRes.body);
    expect(leaksNothing(failing.body)).toEqual([]);
  });

  it('is for a segment of the project, and for someone with access', async () => {
    const { b } = await setup();
    expect(
      (await post(b, `/api/projects/job/segments/999999/suggestion${Q()}`)).statusCode,
    ).toBe(404);
    expect(
      (await post(b, `/api/projects/job/segments/abc/suggestion${Q()}`)).statusCode,
    ).toBe(404);
    const c = await login('carol');
    expect(
      (await post(c, `/api/projects/job/segments/1/suggestion${Q()}`)).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/projects/job/segments/1/suggestion',
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe('listing the suggestions', () => {
  it('lists the current ones as segment and tokens, to a translator, with nothing about their source', async () => {
    const { a, b, ids } = await setup();
    // A run for the whole project, started by the owner.
    const job = await post(a, '/api/projects/job/draft');
    expect(job.statusCode, job.body).toBe(202);
    const id = (job.json() as { job: { id: string } }).job.id;
    for (let i = 0; i < 500; i++) {
      const state = ((await get(a, `/api/jobs/${id}`)).json() as { state: string }).state;
      if (state !== 'running') break;
      await new Promise((r) => setTimeout(r, 10));
    }

    const res = await get(b, `/api/projects/job/suggestions${Q()}`);
    expect(res.statusCode, res.body).toBe(200);
    const { suggestions } = res.json() as {
      suggestions: Array<{ segmentId: number; tokens: unknown[] }>;
    };
    expect(suggestions.length).toBeGreaterThan(0);
    for (const s of suggestions)
      expect(Object.keys(s).sort()).toEqual(['segmentId', 'tokens']);
    expect(suggestions.map((s) => s.segmentId).every((x) => ids.includes(x))).toBe(true);
    expect(leaksNothing(res.body)).toEqual([]);

    const c = await login('carol');
    expect((await get(c, `/api/projects/job/suggestions${Q()}`)).statusCode).toBe(404);
  });
});

describe('accepting a draft', () => {
  async function drafted() {
    const s = await setup();
    const id = s.ids[0]!;
    const asked = await post(s.b, `/api/projects/job/segments/${id}/suggestion${Q()}`);
    expect((asked.json() as { tokens: unknown }).tokens).not.toBeNull();
    return { ...s, id };
  }

  const baseOf = (id: number) => {
    const db = dbOf();
    try {
      return listAllSegments(db).find((s) => s.id === id)!.updatedAt;
    } finally {
      db.close();
    }
  };

  it('writes it as a draft for the translator, logs them with the provenance, and uses the suggestion up', async () => {
    const { b, id } = await drafted();
    const res = await post(
      b,
      `/api/projects/job/segments/${id}/suggestion/accept${Q()}`,
      {
        baseUpdatedAt: baseOf(id),
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { segment: { status: string; targetTokens: unknown[] } };
    expect(body.segment.status).toBe('draft');
    expect(body.segment.targetTokens.length).toBeGreaterThan(0);
    // The answer is the segment as saved: nothing about the engine, its model or its prompt.
    expect(leaksNothing(res.body.replace('mt_draft', ''))).toEqual([]);

    const db = dbOf();
    const event = listEvents(db, { subjectType: 'segment', subjectId: String(id) })
      .filter((e) => e.action === 'segment.target_set')
      .at(-1)!;
    expect(event.actor).toBe(`account:${bob.id}`);
    expect(JSON.parse(event.detail!)).toMatchObject({
      status: 'draft',
      origin: 'mt_draft',
      provenance: {
        engine: 'tessera',
        model: 'm-secret-1',
        prompt_version: 'tessera-draft-v1',
      },
    });
    expect(getDraftSuggestion(db, id)).toBeNull();
    expect(listDraftSuggestions(db).some((s) => s.segmentId === id)).toBe(false);
    expect(verifyAudit(db)).toMatchObject({ brokenAt: null });
    db.close();
  });

  it('refuses a stale version with the segment as it stands, and keeps the suggestion', async () => {
    const { b, id } = await drafted();
    const res = await post(
      b,
      `/api/projects/job/segments/${id}/suggestion/accept${Q()}`,
      {
        baseUpdatedAt: '2000-01-01T00:00:00.000Z',
      },
    );
    expect(res.statusCode).toBe(409);
    expect((res.json() as { segment: { id: number } }).segment.id).toBe(id);
    const db = dbOf();
    expect(getDraftSuggestion(db, id)).not.toBeNull();
    db.close();
  });

  it('is 404 without a suggestion, and 409 over a target the translator already wrote', async () => {
    const { b, ids, id } = await drafted();
    const none = ids.find((x) => x !== id)!;
    expect(
      (await post(b, `/api/projects/job/segments/${none}/suggestion/accept${Q()}`, {}))
        .statusCode,
    ).toBe(404);

    const typed = await put(b, `/api/projects/job/segments/${id}${Q()}`, {
      targetTokens: [{ t: 'text', v: 'Mi propia traducción' }],
      baseUpdatedAt: baseOf(id),
    });
    expect(typed.statusCode, typed.body).toBe(200);
    expect(
      (await post(b, `/api/projects/job/segments/${id}/suggestion/accept${Q()}`, {}))
        .statusCode,
    ).toBe(409);
  });

  it('is for someone with access to the project', async () => {
    const { id } = await drafted();
    const c = await login('carol');
    expect(
      (await post(c, `/api/projects/job/segments/${id}/suggestion/accept${Q()}`, {}))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/projects/job/segments/${id}/suggestion/accept`,
        })
      ).statusCode,
    ).toBe(401);
  });
});
