/**
 * The API server through Fastify's `inject` — no port, no browser: the
 * login gate, the per-account storage root, and the project surface,
 * against a real fixture DOCX.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHash } from 'node:crypto';

import { hashPassword, type AuditActor, type Token } from '@cat-tool/core';
import {
  createAccount,
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

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/docx/form-minimal.docx',
);

/** Who seeds the fixture accounts: not a request, so not a session. */
const SETUP: AuditActor = { actor: { kind: 'system', name: 'test-setup' }, label: null };

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;
let alice: Account;
let bob: Account;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-server-'));
  config = {
    port: 0,
    dbPath: join(dir, 'platform.sqlite'),
    storageRoot: join(dir, 'storage'),
  };
  const platform = openPlatformDb(config.dbPath);
  alice = createAccount(platform, {
    email: 'alice@example.com',
    passwordHash: hashPassword('alice-pw'),
    actor: SETUP,
  });
  bob = createAccount(platform, {
    email: 'bob@example.com',
    passwordHash: hashPassword('bob-pw'),
    actor: SETUP,
  });
  platform.close();
  app = await buildApp({ config, logger: false });
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

async function login(email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email, password },
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { token: string }).token;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function createProject(
  token: string,
  name: string,
  srcLang = 'en',
  tgtLang = 'de',
) {
  return app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: auth(token),
    payload: { name, srcLang, tgtLang },
  });
}

async function upload(token: string, project: string, relPath?: string) {
  const form = new FormData();
  if (relPath) form.append('relPath', relPath);
  form.append('file', new Blob([readFileSync(FIXTURE)]), 'form-minimal.docx');
  return app.inject({
    method: 'POST',
    url: `/api/projects/${project}/files`,
    headers: auth(token),
    payload: form,
  });
}

describe('the login gate', () => {
  it('refuses everything under /api without a live session', async () => {
    for (const url of ['/api/me', '/api/projects', '/api/projects/x']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
    const bogus = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: auth('not-a-token'),
    });
    expect(bogus.statusCode).toBe(401);
  });

  it('refuses a wrong password and an unknown email alike', async () => {
    for (const payload of [
      { email: 'alice@example.com', password: 'wrong' },
      { email: 'nobody@example.com', password: 'alice-pw' },
      { email: 'alice@example.com' },
      {},
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/login', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(401);
    }
  });

  it('logs in, identifies the account without its secrets, and logs out', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email: 'alice@example.com', password: 'alice-pw' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      token: string;
      expiresAt: string;
      account: Record<string, unknown>;
    };
    expect(body.account).toEqual({
      id: alice.id,
      email: 'alice@example.com',
      createdAt: alice.createdAt,
    });
    expect(JSON.stringify(body)).not.toContain(alice.storageRoot);

    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: auth(body.token),
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { email: string }).email).toBe('alice@example.com');

    const out = await app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: auth(body.token),
    });
    expect(out.statusCode).toBe(200);
    const after = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: auth(body.token),
    });
    expect(after.statusCode).toBe(401);
  });
});

describe('projects under the account root', () => {
  it('creates a project as one .catdb under the account root, and refuses a second by that name', async () => {
    const token = await login('alice@example.com', 'alice-pw');
    const created = await createProject(token, 'client-brief');
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      name: 'client-brief',
      project: { name: 'client-brief', srcLang: 'en', tgtLang: 'de' },
      fileCount: 0,
    });
    expect(
      existsSync(
        join(config.storageRoot, alice.storageRoot, 'projects', 'client-brief.catdb'),
      ),
    ).toBe(true);

    const again = await createProject(token, 'client-brief');
    expect(again.statusCode).toBe(409);

    const list = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: auth(token),
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as Array<{ name: string }>).map((p) => p.name)).toEqual([
      'client-brief',
    ]);
  });

  it('never builds a path from a name it did not validate', async () => {
    const token = await login('alice@example.com', 'alice-pw');
    for (const name of ['../escape', 'Has Spaces', 'dots.catdb', '-leading', '', 'a/b']) {
      const res = await createProject(token, name);
      expect(res.statusCode, JSON.stringify(name)).toBe(400);
      const get = await app.inject({
        method: 'GET',
        url: `/api/projects/${encodeURIComponent(name)}`,
        headers: auth(token),
      });
      expect([400, 404], JSON.stringify(name)).toContain(get.statusCode);
    }
    expect(existsSync(join(config.storageRoot, 'escape.catdb'))).toBe(false);
  });

  it('requires the language pair', async () => {
    const token = await login('alice@example.com', 'alice-pw');
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: auth(token),
      payload: { name: 'x', srcLang: 'en' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('keeps one account’s projects invisible to another', async () => {
    const aliceToken = await login('alice@example.com', 'alice-pw');
    const bobToken = await login('bob@example.com', 'bob-pw');
    expect((await createProject(aliceToken, 'shared-name')).statusCode).toBe(201);

    const bobList = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: auth(bobToken),
    });
    expect(bobList.json()).toEqual([]);
    const bobGet = await app.inject({
      method: 'GET',
      url: '/api/projects/shared-name',
      headers: auth(bobToken),
    });
    expect(bobGet.statusCode).toBe(404);

    // Bob may use the same name: it is his own file, under his own root.
    expect((await createProject(bobToken, 'shared-name', 'en', 'fr')).statusCode).toBe(
      201,
    );
    expect(alice.storageRoot).not.toBe(bob.storageRoot);
    expect(
      existsSync(
        join(config.storageRoot, bob.storageRoot, 'projects', 'shared-name.catdb'),
      ),
    ).toBe(true);
  });
});

describe('files and segments', () => {
  it('imports a DOCX through assembleFile and serves its segments', async () => {
    const token = await login('alice@example.com', 'alice-pw');
    expect((await createProject(token, 'job')).statusCode).toBe(201);

    const uploaded = await upload(token, 'job');
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const body = uploaded.json() as {
      file: { id: number; relPath: string; segmentCount: number };
      locked: number;
    };
    expect(body.file.relPath).toBe('form-minimal.docx');
    expect(body.file.segmentCount).toBeGreaterThan(0);

    const project = await app.inject({
      method: 'GET',
      url: '/api/projects/job',
      headers: auth(token),
    });
    expect(project.statusCode).toBe(200);
    const files = (
      project.json() as { files: Array<{ id: number; segmentCount: number }> }
    ).files;
    expect(files).toHaveLength(1);
    expect(files[0]!.segmentCount).toBe(body.file.segmentCount);
    // Never the original bytes or the skeleton on the wire.
    expect(project.body).not.toContain('originalBlob');
    expect(project.body).not.toContain('skeleton');

    const segments = await app.inject({
      method: 'GET',
      url: `/api/projects/job/files/${body.file.id}/segments`,
      headers: auth(token),
    });
    expect(segments.statusCode).toBe(200);
    const list = (segments.json() as { segments: Array<{ sourceTokens: unknown[] }> })
      .segments;
    expect(list).toHaveLength(body.file.segmentCount);
    expect(list[0]!.sourceTokens.length).toBeGreaterThan(0);

    const missing = await app.inject({
      method: 'GET',
      url: '/api/projects/job/files/99/segments',
      headers: auth(token),
    });
    expect(missing.statusCode).toBe(404);
  });

  it('refuses a duplicate rel_path and honours an explicit one', async () => {
    const token = await login('alice@example.com', 'alice-pw');
    await createProject(token, 'job');
    expect((await upload(token, 'job')).statusCode).toBe(201);
    expect((await upload(token, 'job')).statusCode).toBe(409);
    const renamed = await upload(token, 'job', 'copy.docx');
    expect(renamed.statusCode).toBe(201);
    expect((renamed.json() as { file: { relPath: string } }).file.relPath).toBe(
      'copy.docx',
    );
  });

  it('refuses an upload into a project whose source language cannot be segmented', async () => {
    const token = await login('alice@example.com', 'alice-pw');
    await createProject(token, 'jp', 'ja', 'en');
    const res = await upload(token, 'jp');
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('cannot segment ja');
  });

  it('wants a file part', async () => {
    const token = await login('alice@example.com', 'alice-pw');
    await createProject(token, 'job');
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/job/files',
      headers: { ...auth(token), 'content-type': 'application/json' },
      payload: {},
    });
    expect([400, 406, 415]).toContain(res.statusCode);
  });
});

interface PlatformEvent {
  id: number;
  actor: string;
  actor_label: string | null;
  action: string;
  subject_type: string;
  subject_id: string | null;
  detail: string | null;
}

/** `platform.sqlite`'s log, read through a second connection. */
function platformEvents(): PlatformEvent[] {
  const db = openPlatformDb(config.dbPath);
  try {
    return db
      .prepare(
        'SELECT id, actor, actor_label, action, subject_type, subject_id, detail FROM audit_event ORDER BY id',
      )
      .all() as PlatformEvent[];
  } finally {
    db.close();
  }
}

/** The platform events `run` leaves behind. */
async function newEvents(run: () => Promise<unknown>): Promise<PlatformEvent[]> {
  const before = platformEvents().length;
  await run();
  return platformEvents().slice(before);
}

const projectFile = (account: Account, name: string) =>
  join(config.storageRoot, account.storageRoot, 'projects', `${name}.catdb`);

async function jobWithFile(token: string): Promise<{ fileId: number }> {
  expect((await createProject(token, 'job')).statusCode).toBe(201);
  const uploaded = await upload(token, 'job');
  expect(uploaded.statusCode, uploaded.body).toBe(201);
  return { fileId: (uploaded.json() as { file: { id: number } }).file.id };
}

/** The file's first segment with visible text, and its id. */
async function firstSegment(token: string, fileId: number) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/projects/job/files/${fileId}/segments`,
    headers: auth(token),
  });
  const segments = (
    res.json() as {
      segments: Array<{ id: number; locked: boolean; sourceTokens: Token[] }>;
    }
  ).segments;
  return segments.find((s) => !s.locked)!;
}

describe('the audit trail (audit-spec.md §2.5)', () => {
  it('records a login as the account itself, exactly once', async () => {
    const events = await newEvents(() => login('alice@example.com', 'alice-pw'));
    expect(events).toMatchObject([
      {
        actor: `account:${alice.id}`,
        actor_label: 'alice@example.com',
        action: 'auth.login',
        subject_type: 'account',
        subject_id: String(alice.id),
      },
    ]);
  });

  it('records a failed login against the gate, never the account it named', async () => {
    const wrong = await newEvents(() =>
      app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { email: 'alice@example.com', password: 'wrong' },
      }),
    );
    expect(wrong).toMatchObject([
      {
        actor: 'system:login',
        actor_label: null,
        action: 'auth.login_failed',
        subject_id: String(alice.id),
        detail: '{"reason":"wrong_password"}',
      },
    ]);
    const unknown = await newEvents(() =>
      app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { email: 'mallory@example.com', password: 'x' },
      }),
    );
    expect(unknown).toMatchObject([
      { actor: 'system:login', subject_id: null, detail: '{"reason":"unknown_email"}' },
    ]);
    // Nothing that was typed is in the log.
    expect(JSON.stringify(platformEvents())).not.toContain('mallory');
  });

  it('records a logout once, and a project created and deleted by the session', async () => {
    const token = await login('alice@example.com', 'alice-pw');
    const created = await newEvents(() => createProject(token, 'job'));
    expect(created).toMatchObject([
      {
        actor: `account:${alice.id}`,
        action: 'project.created',
        subject_type: 'project',
        subject_id: `${alice.id}/job`,
        detail: null,
      },
    ]);

    const deleted = await newEvents(async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/projects/job',
        headers: auth(token),
      });
      expect(res.statusCode, res.body).toBe(204);
    });
    expect(deleted).toMatchObject([
      {
        actor: `account:${alice.id}`,
        action: 'project.deleted',
        subject_id: `${alice.id}/job`,
      },
    ]);
    expect(existsSync(projectFile(alice, 'job'))).toBe(false);
    const gone = await app.inject({
      method: 'DELETE',
      url: '/api/projects/job',
      headers: auth(token),
    });
    expect(gone.statusCode).toBe(404);

    const out = await newEvents(() =>
      app.inject({ method: 'POST', url: '/api/logout', headers: auth(token) }),
    );
    expect(out).toMatchObject([{ actor: `account:${alice.id}`, action: 'auth.logout' }]);
    expect(verifyAuditOf(config.dbPath)).toEqual({
      brokenAt: null,
      events: expect.any(Number),
    });
  });

  it('records a download once, with the digest of the bytes that left', async () => {
    const token = await login('alice@example.com', 'alice-pw');
    const { fileId } = await jobWithFile(token);
    let bytes: Buffer | undefined;
    const events = await newEvents(async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/job/files/${fileId}/export`,
        headers: auth(token),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-disposition']).toContain('form-minimal.docx');
      bytes = res.rawPayload;
    });
    const sha256 = createHash('sha256').update(bytes!).digest('hex');
    expect(events).toMatchObject([
      {
        actor: `account:${alice.id}`,
        actor_label: 'alice@example.com',
        action: 'file.downloaded',
        subject_type: 'project',
        subject_id: `${alice.id}/job`,
        detail: JSON.stringify({ file_id: fileId, name: 'form-minimal.docx', sha256 }),
      },
    ]);
    // The project's own log says it was produced, by whom, the same bytes.
    const db = openProjectDb(projectFile(alice, 'job'));
    try {
      const exported = listEvents(db, { subjectType: 'file', subjectId: String(fileId) });
      expect(exported.map((e) => [e.action, e.actor, e.detail])).toContainEqual([
        'project.exported',
        `account:${alice.id}`,
        JSON.stringify({ sha256 }),
      ]);
    } finally {
      db.close();
    }

    const missing = await newEvents(async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/projects/job/files/99/export',
        headers: auth(token),
      });
      expect(res.statusCode).toBe(404);
    });
    expect(missing).toEqual([]);
  });

  it("lands a segment edit in the project's log, not the platform's", async () => {
    const token = await login('alice@example.com', 'alice-pw');
    const { fileId } = await jobWithFile(token);
    const segment = await firstSegment(token, fileId);
    const target: Token[] = [{ t: 'text', v: 'Ein Zieltext' }];

    const events = await newEvents(async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/projects/job/segments/${segment.id}`,
        headers: auth(token),
        payload: { targetTokens: target, status: 'translated', origin: null },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        changed: true,
        segment: { id: segment.id, targetTokens: target, status: 'translated' },
      });
    });
    expect(events).toEqual([]);

    const db = openProjectDb(projectFile(alice, 'job'));
    try {
      const history = listEvents(db, {
        subjectType: 'segment',
        subjectId: String(segment.id),
      });
      expect(history.map((e) => [e.action, e.actor, e.actorLabel])).toEqual([
        ['segment.target_set', `account:${alice.id}`, 'alice@example.com'],
      ]);
      expect(verifyAudit(db).brokenAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it('refuses a segment write it cannot store faithfully', async () => {
    const token = await login('alice@example.com', 'alice-pw');
    const { fileId } = await jobWithFile(token);
    const segment = await firstSegment(token, fileId);
    const put = (payload: Record<string, unknown>, id: number = segment.id) =>
      app.inject({
        method: 'PUT',
        url: `/api/projects/job/segments/${id}`,
        headers: auth(token),
        payload,
      });
    const text = [{ t: 'text', v: 'x' }];
    expect(
      (await put({ targetTokens: text, status: 'confirmed', origin: null })).statusCode,
    ).toBe(400);
    expect(
      (await put({ targetTokens: text, status: 'bogus', origin: null })).statusCode,
    ).toBe(400);
    expect((await put({ targetTokens: text, status: 'draft' })).statusCode).toBe(400);
    expect(
      (
        await put({
          targetTokens: [{ t: 'ph', id: 1, fmt: 999 }],
          status: 'draft',
          origin: null,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await put({ targetTokens: 'x', status: 'draft', origin: null })).statusCode,
    ).toBe(400);
    expect(
      (await put({ targetTokens: text, status: 'draft', origin: null }, 99999))
        .statusCode,
    ).toBe(404);

    // Bob cannot reach Alice's project by name.
    const bobToken = await login('bob@example.com', 'bob-pw');
    const bob = await app.inject({
      method: 'PUT',
      url: `/api/projects/job/segments/${segment.id}`,
      headers: auth(bobToken),
      payload: { targetTokens: text, status: 'draft', origin: null },
    });
    expect(bob.statusCode).toBe(404);
  });

  it('never lets segment text into the application log (spec §5)', async () => {
    const lines: string[] = [];
    const logged = await buildApp({
      config,
      logger: {
        level: 'trace',
        stream: { write: (line: string) => void lines.push(line) },
      },
    });
    try {
      const secret = 'Vertraulicher Zieltext 4711';
      const loginRes = await logged.inject({
        method: 'POST',
        url: '/api/login',
        payload: { email: 'alice@example.com', password: 'alice-pw' },
      });
      const token = (loginRes.json() as { token: string }).token;
      await logged.inject({
        method: 'POST',
        url: '/api/projects',
        headers: auth(token),
        payload: { name: 'job', srcLang: 'en', tgtLang: 'de' },
      });
      const form = new FormData();
      form.append('file', new Blob([readFileSync(FIXTURE)]), 'form-minimal.docx');
      const uploaded = await logged.inject({
        method: 'POST',
        url: '/api/projects/job/files',
        headers: auth(token),
        payload: form,
      });
      const fileId = (uploaded.json() as { file: { id: number } }).file.id;
      const segments = await logged.inject({
        method: 'GET',
        url: `/api/projects/job/files/${fileId}/segments`,
        headers: auth(token),
      });
      const segment = (
        segments.json() as { segments: Array<{ id: number; locked: boolean }> }
      ).segments.find((s) => !s.locked)!;
      const res = await logged.inject({
        method: 'PUT',
        url: `/api/projects/job/segments/${segment.id}`,
        headers: auth(token),
        payload: {
          targetTokens: [{ t: 'text', v: secret }],
          status: 'translated',
          origin: null,
        },
      });
      expect(res.statusCode, res.body).toBe(200);
      // A refused write echoes nothing of what was sent, either.
      await logged.inject({
        method: 'PUT',
        url: `/api/projects/job/segments/${segment.id}`,
        headers: auth(token),
        payload: {
          targetTokens: [{ t: 'text', v: secret }],
          status: 'confirmed',
          origin: null,
        },
      });
    } finally {
      await logged.close();
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('/segments/'))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain('Vertraulicher');
      expect(line).not.toContain('alice-pw');
    }
  });
});

function verifyAuditOf(path: string) {
  const db = openPlatformDb(path);
  try {
    return verifyAudit(db);
  } finally {
    db.close();
  }
}
