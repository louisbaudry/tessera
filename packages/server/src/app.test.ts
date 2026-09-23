/**
 * The API server through Fastify's `inject` — no port, no browser: the
 * login gate, the per-account storage root, and the project surface,
 * against a real fixture DOCX.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashPassword } from '@cat-tool/core';
import { createAccount, openPlatformDb, type Account } from '@cat-tool/db';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/docx/form-minimal.docx',
);

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
  });
  bob = createAccount(platform, {
    email: 'bob@example.com',
    passwordHash: hashPassword('bob-pw'),
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
