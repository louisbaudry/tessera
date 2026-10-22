/**
 * An XLIFF 2.x file through the API (`v1-spec.md` §3.8; issue #169): upload by
 * extension, edit like any segment, download as XLIFF, and the refusals a
 * client sees. Fastify's `inject`, real files, no browser.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashPassword, type AuditActor } from '@cat-tool/core';
import { createAccount, openPlatformDb } from '@cat-tool/db';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/xliff');
const fixture = (name: string) => readFileSync(join(FIXTURES, name));
const SETUP: AuditActor = { actor: { kind: 'system', name: 'test-setup' }, label: null };

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-xliff-srv-'));
  config = {
    port: 0,
    dbPath: join(dir, 'platform.sqlite'),
    storageRoot: join(dir, 'storage'),
  };
  const platform = openPlatformDb(config.dbPath);
  createAccount(platform, {
    email: 'alice@example.com',
    passwordHash: hashPassword('alice-pw'),
    actor: SETUP,
  });
  platform.close();
  app = await buildApp({ config, logger: false });
});
afterEach(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

async function setup(tgtLang = 'de'): Promise<string> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email: 'alice@example.com', password: 'alice-pw' },
  });
  const token = (login.json() as { token: string }).token;
  const made = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'job', srcLang: 'en', tgtLang },
  });
  expect(made.statusCode, made.body).toBe(201);
  return token;
}

const upload = (token: string, name: string, bytes: Buffer) => {
  const form = new FormData();
  form.append('file', new Blob([bytes]), name);
  return app.inject({
    method: 'POST',
    url: '/api/projects/job/files',
    headers: { authorization: `Bearer ${token}` },
    payload: form,
  });
};

describe('XLIFF over the API', () => {
  it('uploads by extension, edits a segment, and downloads XLIFF', async () => {
    const token = await setup();
    const up = await upload(token, 'basic.en-de.xlf', fixture('basic.en-de.xlf'));
    expect(up.statusCode, up.body).toBe(201);
    expect(up.json()).toMatchObject({
      file: { id: 1, kind: 'xliff', relPath: 'basic.en-de.xlf', segmentCount: 10 },
      locked: 1,
    });

    const headers = { authorization: `Bearer ${token}` };
    const segments = (
      await app.inject({
        method: 'GET',
        url: '/api/projects/job/files/1/segments',
        headers,
      })
    ).json() as { segments: Array<{ id: number; updatedAt: string }> };
    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/job/segments/${segments.segments[0]!.id}`,
      headers,
      payload: {
        targetTokens: [{ t: 'text', v: 'Das Gartentor ist offen.' }],
        baseUpdatedAt: segments.segments[0]!.updatedAt,
      },
    });
    expect(put.statusCode, put.body).toBe(200);

    const exported = await app.inject({
      method: 'GET',
      url: '/api/projects/job/files/1/export',
      headers,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toBe('application/xliff+xml');
    expect(exported.body).toContain(
      '<source>The garden gate is open.</source><target>Das Gartentor ist offen.</target>',
    );
  });

  it('refuses XLIFF 1.2, a wrong language pair and broken XML with a 422 that says why', async () => {
    const token = await setup();
    const old = await upload(token, 'old.xlf', fixture('xliff-12.en-de.xlf'));
    expect(old.statusCode).toBe(422);
    expect(old.json().error).toContain('XLIFF 1.2 is not supported');

    const broken = await upload(token, 'broken.xlf', Buffer.from('<xliff><unit>'));
    expect(broken.statusCode).toBe(422);

    const fr = await setup2(token);
    expect(fr.statusCode).toBe(422);
    expect(fr.json().error).toContain("target language is de, the project's is fr");
  });

  async function setup2(token: string) {
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'fr', srcLang: 'en', tgtLang: 'fr' },
    });
    const form = new FormData();
    form.append('file', new Blob([fixture('basic.en-de.xlf')]), 'basic.en-de.xlf');
    return app.inject({
      method: 'POST',
      url: '/api/projects/fr/files',
      headers: { authorization: `Bearer ${token}` },
      payload: form,
    });
  }
});
