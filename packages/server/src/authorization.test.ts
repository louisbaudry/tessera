/**
 * A project granted to another account (backlog #45; vendor-spec.md §3
 * implementation note) through Fastify's `inject`: a grantee reaches the
 * editor routes of the owner's project and nothing else, no grant is a 404
 * that tells nothing, and deleting a project takes its grants with it.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashPassword, type AuditActor, type Segment } from '@cat-tool/core';
import {
  createAccount,
  grantProjectAuthorization,
  listEvents,
  openPlatformDb,
  openProjectDb,
  revokeProjectAuthorization,
  type Account,
} from '@cat-tool/db';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/docx/form-minimal.docx',
);
const SETUP: AuditActor = { actor: { kind: 'system', name: 'test-setup' }, label: null };

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;
let alice: Account; // the owner
let bob: Account; // a vendor, granted on alice's `job`
let carol: Account; // an owner with a `job` of her own, and no grant anywhere

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-authz-'));
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

async function login(name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email: `${name}@example.com`, password: `${name}-pw` },
  });
  return (res.json() as { token: string }).token;
}

const as = (token: string) => ({ authorization: `Bearer ${token}` });

/** Creates `job` under `token`'s account with the fixture uploaded; returns its first segment. */
async function projectWithFile(
  token: string,
): Promise<{ fileId: number; segment: Segment }> {
  const made = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: as(token),
    payload: { name: 'job', srcLang: 'en', tgtLang: 'de', writeTm: 'mem' },
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
  const fileId = (up.json() as { file: { id: number } }).file.id;
  const segs = await app.inject({
    method: 'GET',
    url: `/api/projects/job/files/${fileId}/segments`,
    headers: as(token),
  });
  return { fileId, segment: (segs.json() as { segments: Segment[] }).segments[0]! };
}

function grant(accountId: number, owner: Account = alice, name = 'job'): void {
  const platform = openPlatformDb(config.dbPath);
  try {
    grantProjectAuthorization(platform, {
      accountId,
      project: { accountId: owner.id, name },
      scope: 'assigned_translator',
      actor: SETUP,
    });
  } finally {
    platform.close();
  }
}

const get = (token: string, url: string) =>
  app.inject({ method: 'GET', url, headers: as(token) });

describe('a project nobody granted', () => {
  it('is a 404 on every editor route, and the same 404 as a project that does not exist', async () => {
    const a = await login('alice');
    const b = await login('bob');
    const { fileId, segment } = await projectWithFile(a);
    const base = `/api/projects/job`;
    const q = `owner=${alice.id}`;
    const probes = [
      ['GET', `${base}?${q}`],
      ['GET', `${base}/files/${fileId}/segments?${q}`],
      ['GET', `${base}/files/${fileId}/qa-issues?${q}`],
      ['PUT', `${base}/segments/${segment.id}?${q}`],
      ['POST', `${base}/segments/${segment.id}/confirm?${q}`],
    ] as const;
    for (const [method, url] of probes) {
      const res = await app.inject({
        method,
        url,
        headers: as(b),
        payload: method === 'GET' ? undefined : {},
      });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.body).toBe(JSON.stringify({ error: 'no project named "job"' }));
    }
    // a project that is not there answers identically
    const nothing = await get(b, `/api/projects/nope?${q}`);
    expect(nothing.statusCode).toBe(404);
    expect(nothing.body).toBe(JSON.stringify({ error: 'no project named "nope"' }));
  });

  it('is not reached without ?owner either: the account’s own namespace holds no such project', async () => {
    const a = await login('alice');
    await projectWithFile(a);
    grant(bob.id);
    const b = await login('bob');
    expect((await get(b, '/api/projects/job')).statusCode).toBe(404);
  });

  it('is not made reachable by a grant on another project, or by another owner’s project of the same name', async () => {
    const a = await login('alice');
    const c = await login('carol');
    await projectWithFile(a);
    await projectWithFile(c);
    grant(bob.id, alice, 'some-other-project');
    const b = await login('bob');
    expect((await get(b, `/api/projects/job?owner=${alice.id}`)).statusCode).toBe(404);
    expect((await get(b, `/api/projects/job?owner=${carol.id}`)).statusCode).toBe(404);
  });

  it('is a 404 for an owner that is not a number or not an account', async () => {
    const a = await login('alice');
    await projectWithFile(a);
    grant(bob.id);
    const b = await login('bob');
    for (const owner of ['abc', '0', '-1', '9999', '1.5', '1e3', '']) {
      expect(
        (await get(b, `/api/projects/job?owner=${owner}`)).statusCode,
        `owner=${owner}`,
      ).toBe(404);
    }
  });
});

describe('an assigned translator', () => {
  it('opens the project, its segments and its findings, and sees no other project of the owner', async () => {
    const a = await login('alice');
    const { fileId } = await projectWithFile(a);
    grant(bob.id);
    const b = await login('bob');
    const q = `owner=${alice.id}`;

    const detail = await get(b, `/api/projects/job?${q}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({ name: 'job', files: [{ id: fileId }] });
    expect(
      (await get(b, `/api/projects/job/files/${fileId}/segments?${q}`)).statusCode,
    ).toBe(200);
    expect(
      (await get(b, `/api/projects/job/files/${fileId}/qa-issues?${q}`)).statusCode,
    ).toBe(200);
    // the owner's list is the owner's: a grant adds no listing
    expect((await get(b, '/api/projects')).json()).toEqual([]);
  });

  it('saves and confirms a segment, and the project’s log names the grantee', async () => {
    const a = await login('alice');
    const { fileId, segment } = await projectWithFile(a);
    grant(bob.id);
    const b = await login('bob');
    const q = `owner=${alice.id}`;

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/projects/job/segments/${segment.id}?${q}`,
      headers: as(b),
      payload: {
        targetTokens: [{ t: 'text', v: 'Ein Zieltext' }],
        baseUpdatedAt: segment.updatedAt,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/projects/job/segments/${segment.id}/confirm?${q}`,
      headers: as(b),
      payload: {},
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);

    // the memory it confirmed into is the owner's, found through the project
    const memory = await get(a, '/api/tms');
    expect(memory.json()).toMatchObject([{ slug: 'mem', units: 1 }]);
    expect((await get(b, '/api/tms')).json()).toEqual([]);
    // the write is in the owner's project, as the owner sees it...
    const seen = await get(a, `/api/projects/job/files/${fileId}/segments`);
    const stored = (seen.json() as { segments: Segment[] }).segments[0]!;
    expect(stored.status).toBe('confirmed');
    // ...and the owner's own log says who wrote it
    const projectDb = openProjectDb(
      join(config.storageRoot, alice.storageRoot, 'projects', 'job.catdb'),
    );
    try {
      const history = listEvents(projectDb, {
        subjectType: 'segment',
        subjectId: String(segment.id),
      });
      // Confirming records its own status change besides the save: whatever
      // the events are, every one of them is the grantee's.
      expect(history.map((e) => e.action)).toContain('segment.confirmed');
      expect(history.length).toBeGreaterThanOrEqual(2);
      for (const event of history) {
        expect([event.actor, event.actorLabel]).toEqual([
          `account:${bob.id}`,
          'bob@example.com',
        ]);
      }
    } finally {
      projectDb.close();
    }
  });

  it('is refused 403 on everything that is the owner’s to manage, and nothing is changed', async () => {
    const a = await login('alice');
    const { fileId } = await projectWithFile(a);
    grant(bob.id);
    const b = await login('bob');
    const q = `owner=${alice.id}`;
    const probes: Array<[string, string]> = [
      ['DELETE', `/api/projects/job?${q}`],
      ['POST', `/api/projects/job/files?${q}`],
      ['GET', `/api/projects/job/files/${fileId}/export?${q}`],
      ['GET', `/api/projects/job/tms?${q}`],
      ['POST', `/api/projects/job/tms?${q}`],
      ['PUT', `/api/projects/job/tms?${q}`],
      ['POST', `/api/projects/job/pretranslate?${q}`],
      ['GET', `/api/projects/job/glossaries?${q}`],
      ['POST', `/api/projects/job/glossaries?${q}`],
      ['GET', `/api/projects/job/files/${fileId}/glossary/mismatches?${q}`],
      ['POST', `/api/projects/job/files/${fileId}/glossary/session?${q}`],
    ];
    for (const [method, url] of probes) {
      const res = await app.inject({
        method: method as 'GET',
        url,
        headers: as(b),
        payload: method === 'GET' ? undefined : {},
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    // the project is still there, whole
    expect((await get(a, '/api/projects/job')).statusCode).toBe(200);
  });

  it('loses access when the grant is revoked', async () => {
    const a = await login('alice');
    await projectWithFile(a);
    grant(bob.id);
    const b = await login('bob');
    expect((await get(b, `/api/projects/job?owner=${alice.id}`)).statusCode).toBe(200);
    const platform = openPlatformDb(config.dbPath);
    revokeProjectAuthorization(platform, {
      accountId: bob.id,
      project: { accountId: alice.id, name: 'job' },
      actor: SETUP,
    });
    platform.close();
    expect((await get(b, `/api/projects/job?owner=${alice.id}`)).statusCode).toBe(404);
  });
});

describe('the owner', () => {
  it('may name themselves with ?owner, and still manages their own', async () => {
    const a = await login('alice');
    await projectWithFile(a);
    expect((await get(a, `/api/projects/job?owner=${alice.id}`)).statusCode).toBe(200);
    expect((await get(a, `/api/projects/job/tms?owner=${alice.id}`)).statusCode).toBe(
      200,
    );
  });

  it('takes the grants with a project when deleting it, so a new project of that name is not the grantee’s', async () => {
    const a = await login('alice');
    await projectWithFile(a);
    grant(bob.id);
    const b = await login('bob');
    expect((await get(b, `/api/projects/job?owner=${alice.id}`)).statusCode).toBe(200);

    const del = await app.inject({
      method: 'DELETE',
      url: '/api/projects/job',
      headers: as(a),
    });
    expect(del.statusCode).toBe(204);
    await projectWithFile(a); // the same name again, new work
    expect((await get(b, `/api/projects/job?owner=${alice.id}`)).statusCode).toBe(404);

    const platform = openPlatformDb(config.dbPath);
    try {
      const log = listEvents(platform, {
        subjectType: 'project',
        subjectId: `${alice.id}/job`,
      }).map((e) => [e.action, e.actor]);
      expect(log).toEqual([
        ['project.created', `account:${alice.id}`],
        ['authorization.granted', 'system:test-setup'],
        ['project.deleted', `account:${alice.id}`],
        ['authorization.revoked', `account:${alice.id}`],
        ['project.created', `account:${alice.id}`],
      ]);
    } finally {
      platform.close();
    }
  });
});
