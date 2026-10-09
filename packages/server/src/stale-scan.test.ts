/**
 * The stale-work scan through Fastify's `inject` (smart-glossary-spec.md §6.2,
 * backlog #116): a job over the account's own memory and glossary, whose result
 * is a report. Real files, a real worker thread, no browser.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { hashPassword, type AuditActor } from '@cat-tool/core';
import {
  addVariant,
  createAccount,
  createGlossary,
  createTm,
  insertTerm,
  openPlatformDb,
  recordDecision,
  type Account,
} from '@cat-tool/db';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';
import { JobRegistry } from './jobs.js';
import { glossaryPath, tmPath } from './storage.js';

const SETUP: AuditActor = { actor: { kind: 'system', name: 'test-setup' }, label: null };

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;
let alice: Account;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-stale-scan-'));
  config = {
    port: 0,
    dbPath: join(dir, 'platform.sqlite'),
    storageRoot: join(dir, 'storage'),
  };
  const platform = openPlatformDb(config.dbPath);
  const make = (name: string) =>
    createAccount(platform, {
      email: `${name}@example.com`,
      passwordHash: hashPassword(`${name}-pw`),
      actor: SETUP,
    });
  alice = make('alice');
  make('bob');
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

/** Alice's memory `mem`: three units, one of which uses the old rendering. */
function seed(): void {
  const memPath = tmPath(config.storageRoot, alice, 'mem');
  mkdirSync(dirname(memPath), { recursive: true });
  const tm = createTm(memPath, { name: 'mem', generator: 'test' });
  const now = new Date().toISOString();
  const unit = (uuid: string, source: string, target: string) => {
    const id = tm
      .prepare(
        'INSERT INTO tu (uuid, created_at, updated_at, deleted) VALUES (?, ?, ?, 0)',
      )
      .run(uuid, now, now).lastInsertRowid as number;
    for (const [lang, plain] of [
      ['en', source],
      ['de', target],
    ] as const) {
      tm.prepare(
        `INSERT INTO tuv (tu_id, lang, tokens, plain, hash, quality, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        id,
        lang,
        JSON.stringify([{ t: 'text', v: plain }]),
        plain,
        `${lang}:${plain}`,
        now,
        now,
      );
    }
  };
  unit('u-new', 'Open your account.', 'Öffnen Sie Ihr Konto.');
  unit('u-old', 'Close your account.', 'Schließen Sie Ihren Zugang.');
  unit('u-other', 'Open the door.', 'Öffnen Sie die Tür.');
  tm.close();

  const gPath = glossaryPath(config.storageRoot, alice, 'terms');
  mkdirSync(dirname(gPath), { recursive: true });
  const g = createGlossary(gPath, { name: 'terms', generator: 'test' });
  const term = insertTerm(g);
  addVariant(g, { termId: term.id, lang: 'en', text: 'account' });
  addVariant(g, { termId: term.id, lang: 'de', text: 'Konto' });
  addVariant(g, { termId: term.id, lang: 'de', text: 'Zugang' });
  recordDecision(g, {
    termId: term.id,
    lang: 'de',
    chosen: 'Konto',
    rejected: ['Zugang'],
    kind: 'override',
  });
  g.close();
}

const scan = (token: string, slug: string, body: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/api/tms/${slug}/stale-scan`,
    headers: as(token),
    payload: body,
  });

async function finished(token: string, id: string) {
  for (let i = 0; i < 200; i++) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${id}`,
      headers: as(token),
    });
    const job = res.json() as { state: string; result: unknown; error: string | null };
    if (job.state !== 'running') return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the scan did not finish');
}

describe('POST /api/tms/:slug/stale-scan', () => {
  it('runs as a job and reports the unit that uses the old rendering', async () => {
    seed();
    const a = await login('alice');
    const res = await scan(a, 'mem', { glossary: 'terms', srcLang: 'en', tgtLang: 'de' });
    expect(res.statusCode, res.body).toBe(202);
    const { job } = res.json() as { job: { id: string; kind: string; tm: string } };
    expect(job).toMatchObject({ kind: 'scan', tm: 'mem' });
    expect(res.headers.location).toBe(`/api/jobs/${job.id}`);

    const done = await finished(a, job.id);
    expect(done.state).toBe('done');
    expect(done.result).toMatchObject({
      entries: 1,
      scanned: 3,
      total: 1,
      truncated: false,
      complete: true,
      rows: [
        {
          tuUuid: 'u-old',
          source: 'Close your account.',
          target: 'Schließen Sie Ihren Zugang.',
          kind: 'missing_preferred',
          preferred: 'Konto',
          found: 'Zugang',
        },
      ],
    });
    // the job list shows it, as a scan, so a screen can tell it from an import
    const list = await app.inject({ method: 'GET', url: '/api/jobs', headers: as(a) });
    expect(
      (list.json() as { jobs: Array<{ kind: string }> }).jobs.map((j) => j.kind),
    ).toEqual(['scan']);
  });

  it('refuses a bad body, a bad name, and a memory or glossary that is not there', async () => {
    seed();
    const a = await login('alice');
    const ok = { glossary: 'terms', srcLang: 'en', tgtLang: 'de' };
    expect((await scan(a, 'mem', { ...ok, glossary: 3 })).statusCode).toBe(400);
    expect((await scan(a, 'mem', { ...ok, srcLang: 'not a language' })).statusCode).toBe(
      400,
    );
    expect((await scan(a, 'mem', { ...ok, tgtLang: undefined })).statusCode).toBe(400);
    expect((await scan(a, 'Bad_Name', ok)).statusCode).toBe(400);
    expect((await scan(a, 'mem', { ...ok, glossary: '../terms' })).statusCode).toBe(400);
    expect((await scan(a, 'nope', ok)).statusCode).toBe(404);
    expect((await scan(a, 'mem', { ...ok, glossary: 'nope' })).statusCode).toBe(404);
  });

  it('is the account’s own: another account has no such memory, and no access to the job', async () => {
    seed();
    const a = await login('alice');
    const b = await login('bob');
    expect(
      (await scan(b, 'mem', { glossary: 'terms', srcLang: 'en', tgtLang: 'de' }))
        .statusCode,
    ).toBe(404);
    const { job } = (
      await scan(a, 'mem', { glossary: 'terms', srcLang: 'en', tgtLang: 'de' })
    ).json() as { job: { id: string } };
    expect(
      (await app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: as(b) }))
        .statusCode,
    ).toBe(404);
    await finished(a, job.id);
  });

  it('needs a session', async () => {
    seed();
    const res = await app.inject({
      method: 'POST',
      url: '/api/tms/mem/stale-scan',
      payload: { glossary: 'terms', srcLang: 'en', tgtLang: 'de' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('is a clean empty report, not a failure, for a pair the glossary has no terms for', async () => {
    seed();
    const a = await login('alice');
    const res = await scan(a, 'mem', { glossary: 'terms', srcLang: 'fr', tgtLang: 'it' });
    const { job } = res.json() as { job: { id: string } };
    const done = await finished(a, job.id);
    expect(done.state).toBe('done');
    expect(done.result).toMatchObject({ entries: 0, scanned: 0, total: 0 });
  });
});

describe('the job registry counts a kind apart', () => {
  const handle = {
    done: new Promise<never>(() => undefined),
    cancel: () => undefined,
    progress: () => null,
  };

  it('lets a scan run beside an import, and one of each per account', () => {
    const jobs = new JobRegistry();
    const start = (kind: 'import' | 'scan', accountId = 1) =>
      jobs.start({
        accountId,
        kind,
        tm: 'm',
        handle: handle as never,
        onSettled: () => ({ state: 'cancelled' }),
      });
    start('scan');
    expect(jobs.runningFor(1, 'scan')).toBe(1);
    expect(jobs.runningFor(1, 'import')).toBe(0); // a scan does not block an import
    start('import');
    expect(jobs.runningFor(1, 'import')).toBe(1);
    expect(jobs.runningFor(2, 'scan')).toBe(0); // another account's are not this one's
    expect(jobs.running()).toBe(2);
  });
});
