/**
 * Reference files through Fastify's `inject` (`v1-spec.md` §7.9; issue #203):
 * the owner attaches, a translator on a grant opens, and what each is told of a
 * file differs. Real project databases, no browser.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashPassword, REFERENCE_MAX_BYTES, type AuditActor } from '@cat-tool/core';
import {
  createAccount,
  grantProjectAuthorization,
  openPlatformDb,
  type Account,
} from '@cat-tool/db';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';
import { tenantOf } from './tenant.fixture.js';

const SETUP: AuditActor = { actor: { kind: 'system', name: 'test-setup' }, label: null };
const PDF = Buffer.from('%PDF-1.7\nsynthetic style guide\n');

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;
let alice: Account;
let bob: Account;
let carol: Account;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-ref-srv-'));
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
  grantProjectAuthorization(platform, {
    accountId: bob.id,
    project: { tenantId: tenantOf(config, alice).id, name: 'job' },
    scope: 'assigned_translator',
    actor: SETUP,
  });
  platform.close();
  app = await buildApp({ config, logger: false });
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

async function makeProject(token: string, name = 'job') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: as(token),
    payload: { name, srcLang: 'en', tgtLang: 'de' },
  });
  expect(res.statusCode, res.body).toBe(201);
}

function upload(
  token: string,
  bytes: Buffer,
  filename: string,
  label?: string,
  project = 'job',
) {
  const form = new FormData();
  if (label !== undefined) form.append('label', label);
  form.append('file', new Blob([bytes]), filename);
  return app.inject({
    method: 'POST',
    url: `/api/projects/${project}/reference-files`,
    headers: as(token),
    payload: form,
  });
}

describe('reference files over the API', () => {
  it('the owner attaches a file and sees its name; the bytes come back typed and unsniffable', async () => {
    const token = await login('alice');
    await makeProject(token);
    const up = await upload(token, PDF, 'C:\\Clients\\Acme\\brief.pdf', 'Style guide');
    expect(up.statusCode, up.body).toBe(201);
    expect(up.json().file).toMatchObject({
      id: 1,
      name: 'brief.pdf',
      label: 'Style guide',
      mediaType: 'application/pdf',
      size: PDF.length,
    });

    const list = await app.inject({
      method: 'GET',
      url: '/api/projects/job/reference-files',
      headers: as(token),
    });
    expect(list.json().files).toHaveLength(1);
    expect(list.json().files[0].name).toBe('brief.pdf');

    const content = await app.inject({
      method: 'GET',
      url: '/api/projects/job/reference-files/1/content',
      headers: as(token),
    });
    expect(content.statusCode).toBe(200);
    expect(content.headers['content-type']).toBe('application/pdf');
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    expect(content.headers['cache-control']).toBe('private, no-store');
    expect(content.headers['content-disposition']).toMatch(
      /^inline; filename="brief.pdf"/,
    );
    expect(Buffer.from(content.rawPayload).equals(PDF)).toBe(true);
  });

  it('a translator on a grant opens the file but is never told its name', async () => {
    const token = await login('alice');
    await makeProject(token);
    await upload(token, PDF, 'Acme-confidential.pdf', 'Style guide');
    await upload(token, PDF, 'Acme-other.pdf');
    const asBob = await login('bob');
    const q = `?tenant=${tenantOf(config, alice).id}`;

    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/job/reference-files${q}`,
      headers: as(asBob),
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.body).not.toContain('Acme');
    expect(list.json().files).toEqual([
      { id: 1, label: 'Style guide', mediaType: 'application/pdf', size: PDF.length },
      { id: 2, label: null, mediaType: 'application/pdf', size: PDF.length },
    ]);

    const content = await app.inject({
      method: 'GET',
      url: `/api/projects/job/reference-files/2/content${q}`,
      headers: as(asBob),
    });
    expect(content.statusCode).toBe(200);
    expect(content.headers['content-disposition']).toBe(
      'inline; filename="reference-2.pdf"; filename*=UTF-8\'\'reference-2.pdf',
    );
    expect(JSON.stringify(content.headers)).not.toContain('Acme');
  });

  it('a translator cannot attach or remove, and a stranger sees a project that is not there', async () => {
    const token = await login('alice');
    await makeProject(token);
    await upload(token, PDF, 'a.pdf');
    const asBob = await login('bob');
    const q = `?tenant=${tenantOf(config, alice).id}`;
    const form = new FormData();
    form.append('file', new Blob([PDF]), 'x.pdf');
    const add = await app.inject({
      method: 'POST',
      url: `/api/projects/job/reference-files${q}`,
      headers: as(asBob),
      payload: form,
    });
    expect(add.statusCode).toBe(403);
    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/projects/job/reference-files/1${q}`,
      headers: as(asBob),
    });
    expect(remove.statusCode).toBe(403);

    const asCarol = await login('carol');
    for (const url of [
      `/api/projects/job/reference-files${q}`,
      `/api/projects/job/reference-files/1/content${q}`,
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: as(asCarol) });
      expect(res.statusCode, url).toBe(404);
    }
    expect(carol.id).not.toBe(alice.id);
  });

  it('refuses a script renamed .pdf, an empty file, an oversize one and a long label', async () => {
    const token = await login('alice');
    await makeProject(token);
    const html = await upload(
      token,
      Buffer.from('<script>alert(1)</script>'),
      'guide.pdf',
    );
    expect(html.statusCode).toBe(415);
    const empty = await upload(token, Buffer.alloc(0), 'a.pdf');
    expect(empty.statusCode).toBe(400);
    const big = Buffer.alloc(REFERENCE_MAX_BYTES + 10, 0x20);
    PDF.copy(big);
    const huge = await upload(token, big, 'big.pdf');
    expect(huge.statusCode).toBe(413);
    const label = await upload(token, PDF, 'a.pdf', 'x'.repeat(81));
    expect(label.statusCode).toBe(400);
    const list = await app.inject({
      method: 'GET',
      url: '/api/projects/job/reference-files',
      headers: as(token),
    });
    expect(list.json().files).toEqual([]);
  });

  it('a file belongs to its project: another project has its own ids', async () => {
    const token = await login('alice');
    await makeProject(token, 'job');
    await makeProject(token, 'other');
    await upload(token, PDF, 'a.pdf', undefined, 'job');
    const crossed = await app.inject({
      method: 'GET',
      url: '/api/projects/other/reference-files/1/content',
      headers: as(token),
    });
    expect(crossed.statusCode).toBe(404);
    const bad = await app.inject({
      method: 'GET',
      url: '/api/projects/job/reference-files/abc/content',
      headers: as(token),
    });
    expect(bad.statusCode).toBe(404);
  });

  it('removes a file and answers the list left, then it is a 404', async () => {
    const token = await login('alice');
    await makeProject(token);
    await upload(token, PDF, 'a.pdf');
    const gone = await app.inject({
      method: 'DELETE',
      url: '/api/projects/job/reference-files/1',
      headers: as(token),
    });
    expect(gone.statusCode).toBe(200);
    expect(gone.json()).toEqual({ files: [] });
    const again = await app.inject({
      method: 'DELETE',
      url: '/api/projects/job/reference-files/1',
      headers: as(token),
    });
    expect(again.statusCode).toBe(404);
  });
});
