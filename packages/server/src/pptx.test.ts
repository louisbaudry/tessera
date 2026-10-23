/**
 * A PPTX through the API (`v1-spec.md` §3.9; issue #169): upload by extension,
 * edit a segment, download a deck, and the refusal a client sees for a file
 * that is not one. Fastify's `inject`, real files, no browser.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPart, hashPassword, readPptx, type AuditActor } from '@cat-tool/core';
import { createAccount, openPlatformDb } from '@cat-tool/db';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/pptx');
const fixture = (name: string) => readFileSync(join(FIXTURES, name));
const SETUP: AuditActor = { actor: { kind: 'system', name: 'test-setup' }, label: null };

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-pptx-srv-'));
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

async function setup(): Promise<string> {
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
    payload: { name: 'job', srcLang: 'en', tgtLang: 'es' },
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

describe('a PPTX over the API', () => {
  it('uploads by extension, edits a segment, and downloads a deck', async () => {
    const token = await setup();
    const up = await upload(token, 'lo-deck.en.pptx', fixture('lo-deck.en.pptx'));
    expect(up.statusCode, up.body).toBe(201);
    expect(up.json().file).toMatchObject({
      id: 1,
      kind: 'pptx',
      relPath: 'lo-deck.en.pptx',
    });
    expect(up.json().file.segmentCount).toBeGreaterThan(10);

    const headers = { authorization: `Bearer ${token}` };
    const { segments } = (
      await app.inject({
        method: 'GET',
        url: '/api/projects/job/files/1/segments',
        headers,
      })
    ).json() as { segments: Array<{ id: number; updatedAt: string; part: string }> };
    expect(segments[0]!.part).toBe('slide1');
    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/job/segments/${segments[0]!.id}`,
      headers,
      payload: {
        targetTokens: [{ t: 'text', v: 'Taller de planificación del jardín' }],
        baseUpdatedAt: segments[0]!.updatedAt,
      },
    });
    expect(put.statusCode, put.body).toBe(200);

    const exported = await app.inject({
      method: 'GET',
      url: '/api/projects/job/files/1/export',
      headers,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    const pkg = readPptx(new Uint8Array(exported.rawPayload));
    expect(new TextDecoder().decode(getPart(pkg, 'ppt/slides/slide1.xml')!)).toContain(
      '<a:t>Taller de planificación del jardín</a:t>',
    );
  });

  it('refuses a .pptx that is not a package, with a 422 that says why', async () => {
    const token = await setup();
    const bad = await upload(token, 'bad.pptx', Buffer.from('not a zip'));
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toContain('cannot read bad.pptx');
    // A DOCX renamed .pptx lacks the presentation part.
    const docx = await upload(
      token,
      'doc.pptx',
      readFileSync(join(FIXTURES, '../docx/form-minimal.docx')),
    );
    expect(docx.statusCode).toBe(422);
    expect(docx.json().error).toContain('missing required part: ppt/presentation.xml');
  });
});
