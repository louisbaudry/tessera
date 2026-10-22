/**
 * Find and replace across a project through Fastify's `inject` (`v1-spec.md` §7.8;
 * backlog #148b): the preview and the apply as bulk jobs on a worker thread, owner
 * only, and a pattern that would hang ended by its time limit with nothing changed.
 * Real files and a real worker thread, no browser.
 */

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashPassword, plainText, type AuditActor, type Token } from '@cat-tool/core';
import {
  createAccount,
  getSegment,
  grantProjectAuthorization,
  listSegments,
  openPlatformDb,
  openProjectDb,
  setSegmentTarget,
  type Account,
} from '@cat-tool/db';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';
import { projectPath } from './storage.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/docx/form-minimal.docx',
);
const SETUP: AuditActor = { actor: { kind: 'system', name: 'test-setup' }, label: null };

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;
let alice: Account;
let bob: Account;

async function start(limits?: { scan?: number; apply?: number }) {
  app = await buildApp({
    config,
    logger: false,
    ...(limits ? { replaceLimitsMs: limits } : {}),
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-replace-'));
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
  platform.close();
});

afterEach(async () => {
  await app?.close();
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
const text = (v: string): Token => ({ t: 'text', v });

/** Alice's project `job` with the fixture uploaded and its first segments translated as given. */
async function seed(targets: string[]): Promise<{ token: string; ids: number[] }> {
  const token = await login('alice');
  const made = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: as(token),
    payload: { name: 'job', srcLang: 'en', tgtLang: 'es' },
  });
  expect(made.statusCode, made.body).toBe(201);
  const form = new FormData();
  form.append('file', new Blob([readFileSync(FIXTURE)]), 'form-minimal.docx');
  const up = await app.inject({
    method: 'POST',
    url: '/api/projects/job/files',
    headers: as(token),
    payload: form,
  });
  expect(up.statusCode, up.body).toBe(201);
  const db = openProjectDb(projectPath(config.storageRoot, alice, 'job'));
  const segments = listSegments(db, 1).filter((s) => !s.locked);
  const ids = targets.map((t, i) => {
    setSegmentTarget(db, segments[i]!.id, {
      targetTokens: [text(t)],
      status: 'translated',
      origin: null,
      actor: SETUP,
    });
    return segments[i]!.id;
  });
  db.close();
  return { token, ids };
}

const post = (token: string, step: 'scan' | 'apply', body: unknown, extra = '') =>
  app.inject({
    method: 'POST',
    url: `/api/projects/job/replace/${step}${extra}`,
    headers: as(token),
    payload: body as Record<string, unknown>,
  });

interface JobView {
  state: string;
  result: unknown;
  error: string | null;
}
async function finished(token: string, id: string): Promise<JobView> {
  for (let i = 0; i < 400; i++) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${id}`,
      headers: as(token),
    });
    const job = res.json() as JobView;
    if (job.state !== 'running') return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the job did not finish');
}
async function run(
  token: string,
  step: 'scan' | 'apply',
  body: unknown,
): Promise<JobView> {
  const res = await post(token, step, body);
  expect(res.statusCode, res.body).toBe(202);
  const { job } = res.json() as { job: { id: string; kind: string; tm: string } };
  expect(job).toMatchObject({ kind: 'replace', tm: 'job' });
  return finished(token, job.id);
}

const targetOf = (id: number) => {
  const db = openProjectDb(projectPath(config.storageRoot, alice, 'job'));
  try {
    return plainText(getSegment(db, id)!.targetTokens ?? []);
  } finally {
    db.close();
  }
};
const batches = () => {
  const db = openProjectDb(projectPath(config.storageRoot, alice, 'job'));
  try {
    return db
      .prepare("SELECT detail FROM audit_event WHERE action = 'project.replaced'")
      .all() as Array<{ detail: string }>;
  } finally {
    db.close();
  }
};

describe('POST /api/projects/:name/replace/scan and /apply', () => {
  it('previews what a run would change, then applies the segments the owner kept', async () => {
    await start();
    const { token, ids } = await seed([
      'Abra la tapa.',
      'Cierre la ventana.',
      'Otra tapa.',
    ]);
    const find = { pattern: 'tapa', replacement: 'cubierta' };

    const preview = await run(token, 'scan', find);
    expect(preview.state).toBe('done');
    const scan = preview.result as {
      proposals: Array<{
        segmentId: number;
        updatedAt: string;
        before: string;
        after: string;
      }>;
      truncated: boolean;
    };
    expect(scan.proposals.map((p) => [p.segmentId, p.before, p.after])).toEqual([
      [ids[0], 'Abra la tapa.', 'Abra la cubierta.'],
      [ids[2], 'Otra tapa.', 'Otra cubierta.'],
    ]);
    // A preview writes nothing.
    expect(targetOf(ids[0]!)).toBe('Abra la tapa.');
    expect(batches()).toEqual([]);

    // Keep only the first.
    const kept = scan.proposals[0]!;
    const applied = await run(token, 'apply', {
      ...find,
      chosen: [{ segmentId: kept.segmentId, updatedAt: kept.updatedAt }],
    });
    expect(applied.state).toBe('done');
    expect(applied.result).toMatchObject({ segments: 1, matches: 1, stale: 0 });
    expect(targetOf(ids[0]!)).toBe('Abra la cubierta.');
    expect(targetOf(ids[2]!)).toBe('Otra tapa.');
    const [batch] = batches();
    expect(JSON.parse(batch!.detail)).toMatchObject({ segments: 1, regex: false });
    expect(batch!.detail).not.toMatch(/tapa|cubierta/);
  });

  it('replaces with a regular expression and says when it is one', async () => {
    await start();
    const { token, ids } = await seed(['Pieza 12 y pieza 7.']);
    const body = {
      pattern: '[Pp]ieza (\\d+)',
      replacement: 'parte $1',
      regex: true,
      caseSensitive: true,
    };
    const scan = (await run(token, 'scan', body)).result as {
      proposals: Array<{ segmentId: number; updatedAt: string; after: string }>;
    };
    expect(scan.proposals[0]!.after).toBe('parte 12 y parte 7.');
    await run(token, 'apply', {
      ...body,
      chosen: scan.proposals.map((p) => ({
        segmentId: p.segmentId,
        updatedAt: p.updatedAt,
      })),
    });
    expect(targetOf(ids[0]!)).toBe('parte 12 y parte 7.');
  });

  it('skips a segment that changed after the preview and says so', async () => {
    await start();
    const { token, ids } = await seed(['Abra la tapa.']);
    const find = { pattern: 'tapa', replacement: 'cubierta' };
    const scan = (await run(token, 'scan', find)).result as {
      proposals: Array<{ segmentId: number; updatedAt: string }>;
    };
    // The translator edits it between the preview and the apply.
    const db = openProjectDb(projectPath(config.storageRoot, alice, 'job'));
    setSegmentTarget(db, ids[0]!, {
      targetTokens: [text('Texto nuevo de la tapa.')],
      status: 'translated',
      origin: null,
      actor: SETUP,
    });
    db.close();
    const applied = await run(token, 'apply', {
      ...find,
      chosen: scan.proposals.map((p) => ({
        segmentId: p.segmentId,
        updatedAt: p.updatedAt,
      })),
    });
    expect(applied.result).toMatchObject({ segments: 0, stale: 1, batchId: null });
    expect(targetOf(ids[0]!)).toBe('Texto nuevo de la tapa.');
  });

  it('refuses a pattern that cannot run, and bad bodies, before any job starts', async () => {
    await start();
    const { token } = await seed(['x']);
    const bad = (body: unknown) => post(token, 'scan', body);
    expect((await bad({ pattern: '' })).statusCode).toBe(400);
    expect((await bad({ pattern: 7 })).statusCode).toBe(400);
    expect((await bad({ pattern: '(', regex: true })).statusCode).toBe(400);
    expect((await bad({ pattern: 'a*', regex: true })).statusCode).toBe(400);
    expect((await bad({ pattern: 'a', replacement: 3 })).statusCode).toBe(400);
    expect((await bad({ pattern: 'a', regex: 'yes' })).statusCode).toBe(400);
    expect((await bad({ pattern: 'a', fileId: 0 })).statusCode).toBe(400);
    expect((await bad({ pattern: 'a'.repeat(201) })).statusCode).toBe(400);
    const apply = (chosen: unknown) => post(token, 'apply', { pattern: 'a', chosen });
    expect((await apply(undefined)).statusCode).toBe(400);
    expect((await apply([])).statusCode).toBe(400);
    expect((await apply([{ segmentId: 1 }])).statusCode).toBe(400);
    expect((await apply([{ segmentId: '1', updatedAt: 'x' }])).statusCode).toBe(400);
    const many = Array.from({ length: 501 }, (_, i) => ({
      segmentId: i + 1,
      updatedAt: 'x',
    }));
    expect((await apply(many)).statusCode).toBe(400);
  });

  it('ends a pattern that would hang at its limit, and an apply leaves the project as it was', async () => {
    await start({ scan: 400, apply: 400 });
    const hostile = `${'a'.repeat(40)}b`;
    const { token, ids } = await seed([hostile]);
    const find = {
      pattern: '(a+)+$',
      replacement: 'x',
      regex: true,
      caseSensitive: true,
    };

    const scanned = await run(token, 'scan', find);
    expect(scanned.state).toBe('failed');
    expect(scanned.error).toMatch(/took too long/);

    const db = openProjectDb(projectPath(config.storageRoot, alice, 'job'));
    const updatedAt = getSegment(db, ids[0]!)!.updatedAt;
    db.close();
    const applied = await run(token, 'apply', {
      ...find,
      chosen: [{ segmentId: ids[0]!, updatedAt }],
    });
    expect(applied.state).toBe('failed');
    expect(applied.error).toMatch(/nothing was changed/);
    expect(targetOf(ids[0]!)).toBe(hostile);
    expect(batches()).toEqual([]);
    // Neither answer repeats what was searched.
    expect(JSON.stringify([scanned, applied])).not.toContain('(a+)+');
  }, 30_000);

  it('allows one run at a time for an account', async () => {
    await start({ scan: 5000, apply: 5000 });
    const { token } = await seed([`${'a'.repeat(40)}b`]);
    const find = {
      pattern: '(a+)+$',
      regex: true,
      caseSensitive: true,
      replacement: 'x',
    };
    const first = await post(token, 'scan', find);
    expect(first.statusCode).toBe(202);
    const second = await post(token, 'scan', find);
    expect(second.statusCode).toBe(409);
    // Cancelling the first frees the account.
    const { job } = first.json() as { job: { id: string } };
    await app.inject({
      method: 'DELETE',
      url: `/api/jobs/${job.id}`,
      headers: as(token),
    });
    expect((await finished(token, job.id)).state).toBe('cancelled');
  }, 30_000);

  it('is the owner’s alone: a translator on a grant is refused, a stranger sees nothing', async () => {
    await start();
    const { token, ids } = await seed(['Abra la tapa.']);
    const platform = openPlatformDb(config.dbPath);
    grantProjectAuthorization(platform, {
      accountId: bob.id,
      project: { accountId: alice.id, name: 'job' },
      scope: 'assigned_translator',
      actor: SETUP,
    });
    platform.close();
    const asBob = await login('bob');
    const q = `?owner=${alice.id}`;
    expect((await post(asBob, 'scan', { pattern: 'tapa' }, q)).statusCode).toBe(403);
    expect(
      (
        await post(
          asBob,
          'apply',
          { pattern: 'tapa', chosen: [{ segmentId: ids[0], updatedAt: 'x' }] },
          q,
        )
      ).statusCode,
    ).toBe(403);
    expect(targetOf(ids[0]!)).toBe('Abra la tapa.');
    // Without the owner's id the project is simply bob's own, which is not there.
    expect((await post(asBob, 'scan', { pattern: 'tapa' })).statusCode).toBe(404);
    expect(token).toBeTruthy();
  });

  it('needs a login', async () => {
    await start();
    for (const step of ['scan', 'apply'] as const) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/job/replace/${step}`,
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    }
  });
});
