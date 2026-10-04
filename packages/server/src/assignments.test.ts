/**
 * The assignment routes through Fastify's `inject` (backlog #48;
 * vendor-spec.md §4, §6 and the #48 note): the owner offers and posts, a
 * vendor claims, accepts and declines on the owner's roster, a stranger
 * and a non-member get the same 404 as nothing, and accepting opens the
 * owner's project to the vendor through #45's grant.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashPassword, type AuditActor } from '@cat-tool/core';
import {
  addVendor,
  analyseTierWords,
  createAccount,
  createVendorFile,
  listEvents,
  openPlatformDb,
  openProjectDb,
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
let alice: Account; // the owner
let bob: Account; // a vendor on alice's roster
let carol: Account; // another
let dave: Account; // an account on nobody's roster

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-assignments-'));
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
  carol = make('carol', 'vendor');
  dave = make('dave');
  platform.close();

  // alice's roster: bob and carol, written as #51's routes will one day
  const { mkdirSync } = await import('node:fs');
  const rosterPath = join(config.storageRoot, alice.storageRoot, 'vendors.ctv');
  mkdirSync(dirname(rosterPath), { recursive: true });
  const roster = createVendorFile(rosterPath, { generator: 'test' });
  for (const a of [bob, carol]) addVendor(roster, { accountId: a.id, actor: SETUP });
  roster.close();

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

async function aliceWithProject(): Promise<string> {
  const token = await login('alice');
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: as(token),
        payload: { name: 'job', srcLang: 'en', tgtLang: 'de' },
      })
    ).statusCode,
  ).toBe(201);
  const form = new FormData();
  form.append('file', new Blob([readFileSync(FIXTURE)]), 'form-minimal.docx');
  await app.inject({
    method: 'POST',
    url: '/api/projects/job/files',
    headers: as(token),
    payload: form,
  });
  return token;
}

const offerBody = (over: Record<string, unknown> = {}) => ({
  project: 'job',
  channel: 'direct',
  vendors: [bob.id],
  deadline: '2026-03-10T17:00:00Z',
  instructions: 'Formal register.',
  ...over,
});

const post = (token: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/assignments', headers: as(token), payload });

const act = (
  token: string,
  id: number,
  verb: string,
  owner: number | string = alice.id,
) =>
  app.inject({
    method: 'POST',
    url: `/api/assignments/${id}/${verb}?owner=${owner}`,
    headers: as(token),
    payload: {},
  });

const get = (token: string, id: number | string, owner?: number | string) =>
  app.inject({
    method: 'GET',
    url: `/api/assignments/${id}${owner === undefined ? '' : `?owner=${owner}`}`,
    headers: as(token),
  });

describe('the owner offers a project', () => {
  it('pushes it to one vendor on the roster, and sees all of it', async () => {
    const a = await aliceWithProject();
    const res = await post(a, offerBody());
    expect(res.statusCode, res.body).toBe(201);
    const { assignment } = res.json() as { assignment: Record<string, unknown> };
    expect(assignment).toMatchObject({
      id: 1,
      project: 'job',
      channel: 'direct',
      status: 'offered',
      instructions: 'Formal register.',
      vendorAccountId: bob.id,
      eligible: [],
    });
    expect(assignment.events).toMatchObject([
      { from: null, to: 'offered', by: 'alice@example.com' },
    ]);
  });

  it('freezes the project’s tier analysis with the offer, and the owner sees it', async () => {
    const a = await aliceWithProject();
    const projectDb = openProjectDb(projectPath(config.storageRoot, alice, 'job'));
    const now = analyseTierWords(projectDb);
    projectDb.close();
    expect(Object.values(now).reduce((n, w) => n + (w ?? 0), 0)).toBeGreaterThan(0);

    const res = await post(a, offerBody());
    const { assignment } = res.json() as {
      assignment: { analysis: { at: string; words: Record<string, number> } | null };
    };
    expect(assignment.analysis?.words).toEqual(now);
    expect(assignment.analysis?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // The project moves on (every segment now reads as an exact match): the
    // frozen analysis does not.
    const edited = openProjectDb(projectPath(config.storageRoot, alice, 'job'));
    edited.prepare("UPDATE segment SET origin = 'tm_exact'").run();
    expect(analyseTierWords(edited)).not.toEqual(now);
    edited.close();
    const again = await get(a, 1);
    expect(
      (again.json() as { assignment: { analysis: unknown } }).assignment.analysis,
    ).toEqual(assignment.analysis);
  });

  it('posts it to a pool of vendors on the roster', async () => {
    const a = await aliceWithProject();
    const res = await post(
      a,
      offerBody({ channel: 'pool', vendors: [bob.id, carol.id] }),
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      assignment: {
        channel: 'pool',
        status: 'pool_open',
        vendorAccountId: null,
        eligible: [bob.id, carol.id],
      },
    });
  });

  it('creates the roster file itself the first time an owner needs one, then refuses an account not on it', async () => {
    const d = await login('dave');
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: as(d),
      payload: { name: 'mine', srcLang: 'en', tgtLang: 'de' },
    });
    const res = await post(d, offerBody({ project: 'mine', vendors: [bob.id] }));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: `account #${bob.id} is not on your roster` });
  });

  it('refuses a bad body, a project that is not the owner’s, and a direct offer to two', async () => {
    const a = await aliceWithProject();
    const bad = async (over: Record<string, unknown>, code: number) =>
      expect((await post(a, offerBody(over))).statusCode, JSON.stringify(over)).toBe(
        code,
      );
    await bad({ project: '../x' }, 400);
    await bad({ project: 'nope' }, 404);
    await bad({ channel: 'broadcast' }, 400);
    await bad({ vendors: 'bob' }, 400);
    await bad({ vendors: [bob.id, 'x'] }, 400);
    await bad({ vendors: [bob.id, carol.id] }, 400);
    await bad({ channel: 'pool', vendors: [] }, 400);
    await bad({ deadline: 'next week' }, 400);
    await bad({ deadline: 5 }, 400);
    await bad({ instructions: 'x'.repeat(2001) }, 400);
    await bad({ vendors: [999] }, 400);
  });

  it('needs a login', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/assignments',
          payload: offerBody(),
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe('a vendor answers an offer', () => {
  it('accepts it, and can then open the owner’s project in the editor', async () => {
    const a = await aliceWithProject();
    await post(a, offerBody());
    const b = await login('bob');

    // before accepting, the project is not theirs to open
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/projects/job?owner=${alice.id}`,
          headers: as(b),
        })
      ).statusCode,
    ).toBe(404);

    const res = await act(b, 1, 'accept');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ assignment: { id: 1, status: 'accepted' } });

    const editor = await app.inject({
      method: 'GET',
      url: `/api/projects/job?owner=${alice.id}`,
      headers: as(b),
    });
    expect(editor.statusCode, editor.body).toBe(200);
    // and what they may do there is #45's: read and edit, never manage
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/projects/job?owner=${alice.id}`,
          headers: as(b),
        })
      ).statusCode,
    ).toBe(403);

    const platform = openPlatformDb(config.dbPath);
    try {
      expect(
        listEvents(platform, { subjectType: 'project', subjectId: `${alice.id}/job` })
          .filter((e) => e.action === 'authorization.granted')
          .map((e) => [e.actor, JSON.parse(e.detail!)]),
      ).toEqual([
        [`account:${bob.id}`, { grantee: bob.id, scope: 'assigned_translator' }],
      ]);
    } finally {
      platform.close();
    }
  });

  it('declines it, and gets no access to the project', async () => {
    const a = await aliceWithProject();
    await post(a, offerBody());
    const b = await login('bob');
    const res = await app.inject({
      method: 'POST',
      url: `/api/assignments/1/decline?owner=${alice.id}`,
      headers: as(b),
      payload: { note: 'on leave' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ assignment: { status: 'declined' } });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/projects/job?owner=${alice.id}`,
          headers: as(b),
        })
      ).statusCode,
    ).toBe(404);
    // the owner's view says what was said, and by whom
    const view = (await get(a, 1)).json() as {
      assignment: { events: Array<{ to: string; by: string; note: string | null }> };
    };
    expect(view.assignment.events.at(-1)).toMatchObject({
      to: 'declined',
      by: 'bob@example.com',
      note: 'on leave',
    });
  });

  it('answers 409 to an answer that cannot be given again', async () => {
    const a = await aliceWithProject();
    await post(a, offerBody());
    const b = await login('bob');
    expect((await act(b, 1, 'accept')).statusCode).toBe(200);
    expect((await act(b, 1, 'accept')).statusCode).toBe(409);
    expect((await act(b, 1, 'decline')).statusCode).toBe(409);
    expect((await act(b, 1, 'claim')).statusCode).toBe(404); // a claim is the pool's
  });

  it('is a 404, the same as nothing, for a vendor it was not offered to, a stranger and a bad address', async () => {
    const a = await aliceWithProject();
    await post(a, offerBody());
    const c = await login('carol');
    const d = await login('dave');
    const b = await login('bob');
    const nothing = await act(b, 99, 'accept');
    expect(nothing.statusCode).toBe(404);
    for (const [token, verb, owner] of [
      [c, 'accept', alice.id], // another vendor on the roster
      [d, 'accept', alice.id], // an account on nobody's roster
      [b, 'accept', dave.id], // an owner with no roster
      [b, 'accept', 'abc'],
      [b, 'accept', 9999],
      [b, 'accept', bob.id], // themselves
    ] as const) {
      const res = await act(token, 1, verb, owner);
      expect(res.statusCode, `${verb} owner=${owner}`).toBe(404);
      expect(res.body).toBe(nothing.body);
    }
    expect((await get(c, 1, alice.id)).statusCode).toBe(404);
    expect((await get(d, 1, alice.id)).statusCode).toBe(404);
    // nothing changed
    expect((await get(a, 1)).json()).toMatchObject({ assignment: { status: 'offered' } });
  });

  it('is not an owner’s move: the owner’s own id as ?owner is no vendor’s answer', async () => {
    const a = await aliceWithProject();
    await post(a, offerBody());
    expect((await act(a, 1, 'accept', alice.id)).statusCode).toBe(404);
  });
});

describe('the pool', () => {
  it('lets exactly one of two vendors claim it, even asked at once', async () => {
    const a = await aliceWithProject();
    await post(a, offerBody({ channel: 'pool', vendors: [bob.id, carol.id] }));
    const b = await login('bob');
    const c = await login('carol');
    const [rb, rc] = await Promise.all([act(b, 1, 'claim'), act(c, 1, 'claim')]);
    expect([rb.statusCode, rc.statusCode].sort()).toEqual([200, 409]);

    const winner = rb.statusCode === 200 ? bob : carol;
    const view = (await get(a, 1)).json() as {
      assignment: {
        status: string;
        vendorAccountId: number;
        events: Array<{ to: string }>;
      };
    };
    expect(view.assignment).toMatchObject({
      status: 'claimed',
      vendorAccountId: winner.id,
    });
    expect(view.assignment.events.filter((e) => e.to === 'claimed')).toHaveLength(1);
  });

  it('keeps the loser from accepting or declining the winner’s claim', async () => {
    const a = await aliceWithProject();
    await post(a, offerBody({ channel: 'pool', vendors: [bob.id, carol.id] }));
    const b = await login('bob');
    const c = await login('carol');
    expect((await act(b, 1, 'claim')).statusCode).toBe(200);
    expect((await act(c, 1, 'accept')).statusCode).toBe(404);
    expect((await act(c, 1, 'decline')).statusCode).toBe(404);
    expect((await act(c, 1, 'claim')).statusCode).toBe(409);
    expect((await act(b, 1, 'accept')).statusCode).toBe(200);
  });

  it('refuses a claim from a vendor not in the pool, and gives them the pool job’s existence not at all', async () => {
    const a = await aliceWithProject();
    await post(a, offerBody({ channel: 'pool', vendors: [bob.id] }));
    const c = await login('carol');
    expect((await act(c, 1, 'claim')).statusCode).toBe(404);
    expect((await get(c, 1, alice.id)).statusCode).toBe(404);
    const b = await login('bob');
    expect((await get(b, 1, alice.id)).statusCode).toBe(200);
  });

  it('reposts a declined claim to the rest of the pool, and not to the one who declined', async () => {
    const a = await aliceWithProject();
    await post(a, offerBody({ channel: 'pool', vendors: [bob.id, carol.id] }));
    const b = await login('bob');
    const c = await login('carol');
    await act(b, 1, 'claim');
    expect((await act(b, 1, 'decline')).statusCode).toBe(200);

    const again = await get(c, 2, alice.id);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({
      assignment: { id: 2, status: 'pool_open', reopenedFrom: 1, project: 'job' },
    });
    expect((await get(b, 2, alice.id)).statusCode).toBe(404);
    expect((await act(c, 2, 'claim')).statusCode).toBe(200);
  });
});

describe('what each side sees', () => {
  it('shows a vendor the job and nothing about anyone else: no address, no history, no other vendor', async () => {
    const a = await aliceWithProject();
    await post(a, offerBody({ channel: 'pool', vendors: [bob.id, carol.id] }));
    const b = await login('bob');
    const res = await get(b, 1, alice.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      assignment: {
        id: 1,
        project: 'job',
        channel: 'pool',
        status: 'pool_open',
        deadline: '2026-03-10T17:00:00.000Z',
        instructions: 'Formal register.',
        reopenedFrom: null,
      },
    });
    expect(res.body).not.toContain('alice@example.com');
    expect(res.body).not.toContain(alice.storageRoot);
  });

  it('shows the owner no one else’s assignments: their roster is theirs', async () => {
    const a = await aliceWithProject();
    await post(a, offerBody());
    const d = await login('dave');
    expect((await get(d, 1)).statusCode).toBe(404); // dave's own roster has none
    expect((await get(d, 'abc')).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: '/api/assignments/1' })).statusCode,
    ).toBe(401);
  });
});
