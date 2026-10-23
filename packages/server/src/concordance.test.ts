/**
 * Concordance search through Fastify's `inject` (`v1-spec.md` §6.1b; issue
 * #170): an owner's read over the project's attached memories, refused to a
 * translator on a grant, and writing nothing.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashPassword, type AuditActor } from '@cat-tool/core';
import {
  createAccount,
  grantProjectAuthorization,
  openPlatformDb,
  openProjectDb,
  openTm,
  type Account,
} from '@cat-tool/db';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';
import { tenantOf } from './tenant.fixture.js';
import { projectPath, tmPath } from './storage.js';

const SETUP: AuditActor = { actor: { kind: 'system', name: 'test-setup' }, label: null };

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;
let alice: Account; // the owner
let bob: Account; // a vendor, granted on alice's `job`
// carol: an owner with no grant on alice's project

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-concordance-'));
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
  make('carol');
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

/** Alice's project `job` (en to de) with its write memory `mem` holding three units. */
async function seed(): Promise<string> {
  const token = await login('alice');
  const made = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: as(token),
    payload: { name: 'job', srcLang: 'en', tgtLang: 'de', writeTm: 'mem' },
  });
  expect(made.statusCode, made.body).toBe(201);
  const tm = openTm(tmPath(config.storageRoot, tenantOf(config, alice), 'mem'));
  const now = new Date().toISOString();
  const add = (en: string, de: string) => {
    const id = tm
      .prepare('INSERT INTO tu (uuid, created_at, updated_at) VALUES (?, ?, ?)')
      .run(`u${Math.random()}`, now, now).lastInsertRowid as number;
    for (const [lang, text] of [
      ['en', en],
      ['de', de],
    ] as const) {
      tm.prepare(
        `INSERT INTO tuv (tu_id, lang, tokens, plain, hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        lang,
        JSON.stringify([{ t: 'text', v: text }]),
        text,
        `h:${lang}:${text}`,
        now,
        now,
      );
    }
  };
  add('Set up the printer.', 'Richten Sie den Drucker ein.');
  add('Open the lid.', 'Öffnen Sie den Deckel.');
  add('How to set up a network', 'So richten Sie ein Netzwerk ein');
  tm.close();
  return token;
}

const search = (token: string, query: string, extra = '') =>
  app.inject({
    method: 'GET',
    url: `/api/projects/job/concordance?${query}${extra}`,
    headers: as(token),
  });

describe('GET /api/projects/:name/concordance', () => {
  it('finds the phrase in the attached memory, newest first, with ranges and no path', async () => {
    const token = await seed();
    const res = await search(token, 'q=set%20up');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      hits: Array<{ source: string; target: string; ranges: unknown; memory: number }>;
      more: boolean;
      searched: number;
    };
    expect(body.searched).toBe(1);
    expect(body.more).toBe(false);
    expect(body.hits.map((h) => h.source)).toEqual([
      'How to set up a network',
      'Set up the printer.',
    ]);
    expect(body.hits[0]).toMatchObject({
      target: 'So richten Sie ein Netzwerk ein',
      ranges: [{ start: 7, end: 13 }],
      memory: 1,
    });
    // A hit names its memory by position and nothing more.
    expect(res.body).not.toContain('mem.ctm');
    expect(res.body).not.toContain(dir);
  });

  it('searches the target side when asked', async () => {
    const token = await seed();
    const res = await search(token, 'q=deckel&side=target');
    const hits = (res.json() as { hits: Array<{ source: string }> }).hits;
    expect(hits.map((h) => h.source)).toEqual(['Open the lid.']);
  });

  it('answers an empty result, not an error, for a text with no word', async () => {
    const token = await seed();
    const res = await search(token, 'q=%20...%20');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hits: [], more: false, searched: 1 });
  });

  it('refuses a missing text, a bad side and a text that is a sentence', async () => {
    const token = await seed();
    expect((await search(token, '')).statusCode).toBe(400);
    expect((await search(token, 'q=a&side=both')).statusCode).toBe(400);
    expect((await search(token, `q=${'a%20'.repeat(13)}`)).statusCode).toBe(400);
    expect((await search(token, `q=${'a'.repeat(121)}`)).statusCode).toBe(400);
  });

  it('is the owner’s alone: a translator on a grant is refused, a stranger sees nothing', async () => {
    await seed();
    const platform = openPlatformDb(config.dbPath);
    grantProjectAuthorization(platform, {
      accountId: bob.id,
      project: { tenantId: tenantOf(config, alice).id, name: 'job' },
      scope: 'assigned_translator',
      actor: SETUP,
    });
    platform.close();

    const asBob = await search(
      await login('bob'),
      'q=set',
      `&tenant=${tenantOf(config, alice).id}`,
    );
    expect(asBob.statusCode).toBe(403);
    expect(asBob.body).not.toContain('printer');

    const asCarol = await search(
      await login('carol'),
      'q=set',
      `&tenant=${tenantOf(config, alice).id}`,
    );
    expect(asCarol.statusCode).toBe(404);
    // Without ?owner, carol asks for a project of her own that does not exist.
    expect((await search(await login('carol'), 'q=set')).statusCode).toBe(404);
  });

  it('needs a login', async () => {
    await seed();
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/job/concordance?q=set',
    });
    expect(res.statusCode).toBe(401);
  });

  it('writes no event to the project or the memory', async () => {
    const token = await seed();
    const events = () => {
      const db = openProjectDb(
        projectPath(config.storageRoot, tenantOf(config, alice), 'job'),
      );
      try {
        return (
          db.prepare('SELECT COUNT(*) AS n FROM audit_event').get() as { n: number }
        ).n;
      } finally {
        db.close();
      }
    };
    const before = events();
    await search(token, 'q=set%20up');
    expect(events()).toBe(before);
  });
});

interface HitView {
  tuId: number;
  ref: number;
  tuvId: number;
  rev: number;
  editable: boolean;
  source: string;
  target: string;
}

const hitsFor = async (token: string, query: string) =>
  ((await search(token, query)).json() as { hits: HitView[] }).hits;

/** The project's memory events, with their stored detail parsed. */
function memoryEvents(): Array<{ action: string; detail: Record<string, unknown> }> {
  const db = openProjectDb(
    projectPath(config.storageRoot, tenantOf(config, alice), 'job'),
  );
  try {
    return (
      db
        .prepare(
          "SELECT action, detail FROM audit_event WHERE action LIKE 'tm.%' ORDER BY id",
        )
        .all() as Array<{ action: string; detail: string }>
    ).map((e) => ({
      action: e.action,
      detail: JSON.parse(e.detail) as Record<string, unknown>,
    }));
  } finally {
    db.close();
  }
}

const put = (token: string, body: unknown, extra = '') =>
  app.inject({
    method: 'PUT',
    url: `/api/projects/job/memory-units${extra}`,
    headers: as(token),
    payload: body as Record<string, unknown>,
  });
const retire = (token: string, body: unknown, extra = '') =>
  app.inject({
    method: 'POST',
    url: `/api/projects/job/memory-units/retire${extra}`,
    headers: as(token),
    payload: body as Record<string, unknown>,
  });

describe('correcting and retiring a unit (issue #151)', () => {
  it('a hit carries what an edit names: the project\u2019s reference, the variant, its revision', async () => {
    const token = await seed();
    const [hit] = await hitsFor(token, 'q=lid');
    expect(hit).toMatchObject({ ref: 1, rev: 1, editable: true });
    expect(Number.isInteger(hit!.tuvId)).toBe(true);
  });

  it('edits the translation, keeps the old one, and logs the change without its text', async () => {
    const token = await seed();
    const [hit] = await hitsFor(token, 'q=lid');
    const res = await put(token, {
      ref: hit!.ref,
      tuvId: hit!.tuvId,
      rev: hit!.rev,
      text: 'Den Deckel \u00F6ffnen.',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ changed: true, rev: 2 });

    const [after] = await hitsFor(token, 'q=lid');
    expect(after).toMatchObject({ target: 'Den Deckel \u00F6ffnen.', rev: 2 });
    const events = memoryEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'tm.unit_edited',
      detail: { tm_ref: 1, lang: 'de', from_rev: 1, to_rev: 2 },
    });
    expect(JSON.stringify(events)).not.toContain('Deckel');
    // The old text is in the memory's own history, with who changed it.
    const tm = openTm(tmPath(config.storageRoot, tenantOf(config, alice), 'mem'));
    const history = tm
      .prepare('SELECT tokens, changed_by FROM tuv_history WHERE tuv_id = ?')
      .all(hit!.tuvId) as Array<{ tokens: string; changed_by: string | null }>;
    tm.close();
    expect(history).toHaveLength(1);
    expect(history[0]!.tokens).toContain('\u00D6ffnen Sie den Deckel.');
    expect(history[0]!.changed_by).toContain('alice@example.com');
  });

  it('refuses a stale revision with a 409 and writes nothing', async () => {
    const token = await seed();
    const [hit] = await hitsFor(token, 'q=lid');
    const body = { ref: hit!.ref, tuvId: hit!.tuvId, rev: hit!.rev, text: 'Erstens' };
    expect((await put(token, body)).statusCode).toBe(200);
    const again = await put(token, { ...body, text: 'Zweitens' });
    expect(again.statusCode).toBe(409);
    expect((await hitsFor(token, 'q=lid'))[0]!.target).toBe('Erstens');
    expect(
      (await retire(token, { ref: hit!.ref, tuvId: hit!.tuvId, rev: 1 })).statusCode,
    ).toBe(409);
    expect(memoryEvents()).toHaveLength(1);
  });

  it('refuses a reference the project does not hold, bad numbers, and a text it cannot take', async () => {
    const token = await seed();
    const [hit] = await hitsFor(token, 'q=lid');
    const ok = { ref: hit!.ref, tuvId: hit!.tuvId, rev: hit!.rev, text: 'x' };
    expect((await put(token, { ...ok, ref: 99 })).statusCode).toBe(404);
    expect((await put(token, { ...ok, tuvId: 9999 })).statusCode).toBe(404);
    expect((await put(token, { ...ok, ref: '1' })).statusCode).toBe(400);
    expect((await put(token, { ...ok, rev: 0 })).statusCode).toBe(400);
    expect((await put(token, { ...ok, text: 7 })).statusCode).toBe(400);
    expect((await put(token, { ...ok, text: '   ' })).statusCode).toBe(400);
    expect((await put(token, { ...ok, text: 'a'.repeat(5001) })).statusCode).toBe(400);
    expect((await retire(token, { ref: 99, tuvId: hit!.tuvId, rev: 1 })).statusCode).toBe(
      404,
    );
    expect(memoryEvents()).toEqual([]);
  });

  it('refuses a translation that holds tags with a 422, and offers it as not editable', async () => {
    const token = await seed();
    const [hit] = await hitsFor(token, 'q=lid');
    const tm = openTm(tmPath(config.storageRoot, tenantOf(config, alice), 'mem'));
    tm.prepare('UPDATE tuv SET tokens = ? WHERE id = ?').run(
      JSON.stringify([
        { t: 'open', id: 1, k: 'bold' },
        { t: 'text', v: 'Deckel' },
        { t: 'close', id: 1 },
      ]),
      hit!.tuvId,
    );
    tm.close();
    expect((await hitsFor(token, 'q=lid'))[0]!.editable).toBe(false);
    const res = await put(token, {
      ref: hit!.ref,
      tuvId: hit!.tuvId,
      rev: hit!.rev,
      text: 'x',
    });
    expect(res.statusCode).toBe(422);
  });

  it('retires a unit: it is no longer found, the log says so, and a repeat changes nothing', async () => {
    const token = await seed();
    const [hit] = await hitsFor(token, 'q=lid');
    const body = { ref: hit!.ref, tuvId: hit!.tuvId, rev: hit!.rev };
    const res = await retire(token, body);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ changed: true });
    expect(await hitsFor(token, 'q=lid')).toEqual([]);
    expect((await retire(token, body)).json()).toEqual({ changed: false });
    const events = memoryEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'tm.unit_retired', detail: { tm_ref: 1 } });
    // Nothing was deleted: the other units are still found.
    expect((await hitsFor(token, 'q=set')).length).toBe(2);
  });

  it('is the owner\u2019s alone: a translator on a grant is refused and nothing changes', async () => {
    const owner = await seed();
    const [hit] = await hitsFor(owner, 'q=lid');
    const platform = openPlatformDb(config.dbPath);
    grantProjectAuthorization(platform, {
      accountId: bob.id,
      project: { tenantId: tenantOf(config, alice).id, name: 'job' },
      scope: 'assigned_translator',
      actor: SETUP,
    });
    platform.close();

    const asBob = await login('bob');
    const body = { ref: hit!.ref, tuvId: hit!.tuvId, rev: hit!.rev };
    const q = `?tenant=${tenantOf(config, alice).id}`;
    expect((await put(asBob, { ...body, text: 'x' }, q)).statusCode).toBe(403);
    expect((await retire(asBob, body, q)).statusCode).toBe(403);
    const asCarol = await login('carol');
    expect((await put(asCarol, { ...body, text: 'x' }, q)).statusCode).toBe(404);
    expect((await retire(asCarol, body, q)).statusCode).toBe(404);
    expect((await hitsFor(owner, 'q=lid'))[0]).toMatchObject({ rev: 1, editable: true });
    expect(memoryEvents()).toEqual([]);
  });

  it('needs a login', async () => {
    await seed();
    for (const [method, url] of [
      ['PUT', '/api/projects/job/memory-units'],
      ['POST', '/api/projects/job/memory-units/retire'],
    ] as const) {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode).toBe(401);
    }
  });
});
