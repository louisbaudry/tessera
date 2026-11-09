/**
 * Live or deferred QA through Fastify's `inject` (issue #361, `v1-spec.md` §7.10): the mode,
 * an edit that reruns no QA while deferred, and the sweep as a job that catches findings
 * up. Real files and a real worker thread, no browser.
 */

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashPassword, type AuditActor } from '@cat-tool/core';
import {
  createAccount,
  listSegments,
  openPlatformDb,
  openProjectDb,
  type Account,
} from '@cat-tool/db';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';
import { projectPath } from './storage.js';
import { tenantOf } from './tenant.fixture.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/docx/form-minimal.docx',
);
const SETUP: AuditActor = { actor: { kind: 'system', name: 'test-setup' }, label: null };

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;
let alice: Account;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-qa-mode-'));
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
  make('bob', 'vendor');
  platform.close();
  app = await buildApp({ config, logger: false });
});

afterEach(async () => {
  await app?.close();
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

/** Alice's project `job` with the fixture uploaded; returns her token and the first segment's id. */
async function seed(): Promise<{ token: string; segmentId: number; source: string }> {
  const token = await login('alice');
  await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: as(token),
    payload: { name: 'job', srcLang: 'en', tgtLang: 'es' },
  });
  const form = new FormData();
  form.append('file', new Blob([readFileSync(FIXTURE)]), 'form-minimal.docx');
  const up = await app.inject({
    method: 'POST',
    url: '/api/projects/job/files',
    headers: as(token),
    payload: form,
  });
  expect(up.statusCode, up.body).toBe(201);
  const db = openProjectDb(
    projectPath(config.storageRoot, tenantOf(config, alice), 'job'),
  );
  const first = listSegments(db, 1).find((s) => !s.locked)!;
  db.close();
  return {
    token,
    segmentId: first.id,
    source: first.sourceTokens.map((t) => (t.t === 'text' ? t.v : '')).join(''),
  };
}
const mode = (token: string) =>
  app.inject({ method: 'GET', url: '/api/projects/job/qa-mode', headers: as(token) });
const setMode = (token: string, body: unknown) =>
  app.inject({
    method: 'PUT',
    url: '/api/projects/job/qa-mode',
    headers: as(token),
    payload: body as Record<string, unknown>,
  });
const edit = (token: string, segmentId: number, text: string) =>
  app.inject({
    method: 'PUT',
    url: `/api/projects/job/segments/${segmentId}`,
    headers: as(token),
    payload: { targetTokens: [{ t: 'text', v: text }] },
  });
const fileIssues = async (token: string) =>
  (
    (
      await app.inject({
        method: 'GET',
        url: '/api/projects/job/files/1/qa-issues',
        headers: as(token),
      })
    ).json() as { issues: Array<{ rule: string }> }
  ).issues;

interface JobView {
  state: string;
  result: unknown;
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
async function sweep(token: string): Promise<JobView> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects/job/qa/sweep',
    headers: as(token),
  });
  expect(res.statusCode, res.body).toBe(202);
  const { job } = res.json() as { job: { id: string; kind: string; tm: string } };
  expect(job).toMatchObject({ kind: 'qa', tm: 'job' });
  return finished(token, job.id);
}

describe('GET and PUT /api/projects/:name/qa-mode', () => {
  it('is live by default, and the owner can defer and go live again', async () => {
    const { token } = await seed();
    expect((await mode(token)).json()).toEqual({
      deferred: false,
      stale: false,
      unsweptEdits: 0,
    });
    const on = await setMode(token, { deferred: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ deferred: true, stale: false });
    expect((await setMode(token, { deferred: false })).json()).toMatchObject({
      deferred: false,
    });
  });

  it('refuses a body that is not a boolean, and a stranger sees a missing project', async () => {
    const { token } = await seed();
    expect((await setMode(token, { deferred: 'yes' })).statusCode).toBe(400);
    expect((await setMode(token, {})).statusCode).toBe(400);
    const bob = await login('bob');
    expect((await mode(bob)).statusCode).toBe(404);
    expect((await setMode(bob, { deferred: true })).statusCode).toBe(404);
  });
});

describe('an edit in a deferred project, then the sweep', () => {
  it('reruns no QA, reads as stale, refuses to go live, and is caught up by the sweep job', async () => {
    const { token, segmentId, source } = await seed();
    await setMode(token, { deferred: true });

    const saved = await edit(token, segmentId, source); // a copy of the source: seg.untranslated
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ rerun: [], issues: [] });
    expect(await fileIssues(token)).toEqual([]);
    expect((await mode(token)).json()).toEqual({
      deferred: true,
      stale: true,
      unsweptEdits: 1,
    });
    const live = await setMode(token, { deferred: false });
    expect(live.statusCode).toBe(409);
    expect((live.json() as { error: string }).error).toMatch(/run QA/);

    const done = await sweep(token);
    expect(done.state).toBe('done');
    expect(done.result).toMatchObject({ current: true });
    expect((await fileIssues(token)).map((i) => i.rule)).toEqual(['seg.untranslated']);
    expect((await mode(token)).json()).toMatchObject({ deferred: true, stale: false });
    expect((await setMode(token, { deferred: false })).statusCode).toBe(200);
  });

  it('a live project still reruns QA on an edit, as it always did', async () => {
    const { token, segmentId, source } = await seed();
    const saved = await edit(token, segmentId, source);
    expect((saved.json() as { rerun: number[] }).rerun).toContain(segmentId);
    expect((await fileIssues(token)).map((i) => i.rule)).toEqual(['seg.untranslated']);
  });

  it('a live project has nothing to sweep: a 409, and no job', async () => {
    const { token } = await seed();
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/job/qa/sweep',
      headers: as(token),
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(/every edit/);
  });

  it('a sweep of a project nobody can see is a missing project', async () => {
    await seed();
    const bob = await login('bob');
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/job/qa/sweep',
      headers: as(bob),
    });
    expect(res.statusCode).toBe(404);
  });
});
