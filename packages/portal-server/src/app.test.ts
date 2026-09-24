/**
 * The portal API through Fastify's `inject` — no port, no browser: one
 * order from a client's submission to the admin's delivery and the
 * client's download, plus the two boundaries that make delivery safe to
 * expose (another client's order is a 404; an uploaded filename never
 * decides where bytes land).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAdminUser,
  createClient,
  listEvents,
  listOrderEvents,
  openPortalDb,
  setRate,
  verifyAudit,
  type Client,
} from '@cat-tool/db';
import { hashPassword } from '@cat-tool/portal-core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import type { PortalConfig } from './config.js';

let dir: string;
let config: PortalConfig;
let app: FastifyInstance;
let ada: Client;
let other: Client;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-portal-'));
  config = {
    port: 0,
    dbPath: join(dir, 'portal.sqlite'),
    storageRoot: join(dir, 'storage'),
    smtp: undefined,
  };
  const db = openPortalDb(config.dbPath);
  ada = createClient(db, 'Ada', 'ada@example.com', 'ada-token');
  other = createClient(db, 'Someone Else', 'other@example.com', 'other-token');
  createAdminUser(db, 'admin@example.com', hashPassword('admin-pw'));
  setRate(db, { srcLang: 'en', tgtLang: 'es', ratePerWord: 0.1, minimumPrice: 20 });
  db.close();
  app = await buildApp({ config, logger: false });
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function adminLogin(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/login',
    payload: { email: 'admin@example.com', password: 'admin-pw' },
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { token: string }).token;
}

interface FileJson {
  id: number;
  filename: string;
  contentType: string;
  byteSize: number;
}

async function submitOrder(
  token: string,
  files: ReadonlyArray<{ name: string; body: string; type?: string }>,
) {
  const form = new FormData();
  form.append('srcLang', 'en');
  form.append('tgtLangs', 'es');
  form.append('notes', 'please');
  for (const f of files) {
    form.append('files', new Blob([f.body], { type: f.type ?? 'text/plain' }), f.name);
  }
  const res = await app.inject({
    method: 'POST',
    url: '/api/client/orders',
    headers: auth(token),
    payload: form,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { order: { id: number }; files: FileJson[] };
}

async function deliver(
  adminToken: string,
  orderId: number,
  files: ReadonlyArray<{ name: string; body: string; type?: string }>,
  markDelivered = false,
) {
  const form = new FormData();
  if (markDelivered) form.append('markDelivered', 'true');
  for (const f of files) {
    form.append('files', new Blob([f.body], { type: f.type ?? 'text/plain' }), f.name);
  }
  const res = await app.inject({
    method: 'POST',
    url: `/api/admin/orders/${orderId}/deliver`,
    headers: auth(adminToken),
    payload: form,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { order: { status: string }; deliveredFiles: FileJson[] };
}

/** Every file under the storage root, relative to it, sorted. */
function storedFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(config.storageRoot, rel), {
      withFileTypes: true,
    })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next);
      else out.push(next);
    }
  };
  if (existsSync(config.storageRoot)) walk('');
  return out.sort();
}

describe('one order, end to end', () => {
  it('goes from the client upload to the admin download to the delivered file the client fetches', async () => {
    const { order, files } = await submitOrder(ada.accessToken, [
      { name: 'brief.txt', body: 'hello world' },
    ]);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      filename: 'brief.txt',
      contentType: 'text/plain',
      byteSize: 11,
    });
    expect(files[0]).not.toHaveProperty('storagePath');

    // Intake's other half: the admin fetches the source without the volume.
    const admin = await adminLogin();
    const source = await app.inject({
      method: 'GET',
      url: `/api/admin/orders/${order.id}/source-files/${files[0]!.id}`,
      headers: auth(admin),
    });
    expect(source.statusCode, source.body).toBe(200);
    expect(source.body).toBe('hello world');
    expect(source.headers['content-type']).toBe('text/plain');
    expect(source.headers['content-length']).toBe('11');
    expect(source.headers['x-content-type-options']).toBe('nosniff');
    expect(source.headers['content-disposition']).toBe(
      `attachment; filename="brief.txt"; filename*=UTF-8''brief.txt`,
    );

    // Nothing to download yet on the client side.
    const before = await app.inject({
      method: 'GET',
      url: `/api/client/orders/${order.id}`,
      headers: auth(ada.accessToken),
    });
    expect(before.statusCode).toBe(200);
    expect((before.json() as { deliveredFiles: FileJson[] }).deliveredFiles).toEqual([]);

    // Word count, approval, production, delivery — the manual v0 loop.
    const priced = await app.inject({
      method: 'PATCH',
      url: `/api/admin/orders/${order.id}`,
      headers: auth(admin),
      payload: { wordCount: 2 },
    });
    expect(priced.statusCode, priced.body).toBe(200);
    expect((priced.json() as { price: number }).price).toBe(20);
    const approved = await app.inject({
      method: 'POST',
      url: `/api/client/orders/${order.id}/approve`,
      headers: auth(ada.accessToken),
    });
    expect(approved.statusCode, approved.body).toBe(200);
    for (const status of ['in_progress']) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/admin/orders/${order.id}`,
        headers: auth(admin),
        payload: { status },
      });
      expect(res.statusCode, res.body).toBe(200);
    }
    const delivered = await deliver(
      admin,
      order.id,
      [{ name: 'brief.es.txt', body: 'hola mundo' }],
      true,
    );
    expect(delivered.order.status).toBe('delivered');
    expect(delivered.deliveredFiles).toHaveLength(1);
    expect(delivered.deliveredFiles[0]).not.toHaveProperty('storagePath');

    // The delivery itself.
    const detail = await app.inject({
      method: 'GET',
      url: `/api/client/orders/${order.id}`,
      headers: auth(ada.accessToken),
    });
    const { deliveredFiles, events } = detail.json() as {
      deliveredFiles: FileJson[];
      events: Array<{ toStatus: string }>;
    };
    expect(deliveredFiles.map((f) => f.filename)).toEqual(['brief.es.txt']);
    expect(events.map((e) => e.toStatus)).toEqual([
      'submitted',
      'approved',
      'in_progress',
      'delivered',
    ]);
    const download = await app.inject({
      method: 'GET',
      url: `/api/client/orders/${order.id}/delivered-files/${deliveredFiles[0]!.id}`,
      headers: auth(ada.accessToken),
    });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.body).toBe('hola mundo');
    expect(download.headers['content-disposition']).toBe(
      `attachment; filename="brief.es.txt"; filename*=UTF-8''brief.es.txt`,
    );

    // And the admin can re-fetch what was delivered.
    const again = await app.inject({
      method: 'GET',
      url: `/api/admin/orders/${order.id}/delivered-files/${deliveredFiles[0]!.id}`,
      headers: auth(admin),
    });
    expect(again.statusCode).toBe(200);
    expect(again.body).toBe('hola mundo');
  });
});

/** Reads the portal's two logs through a second connection, as an auditor would. */
function readLogs<T>(read: (db: ReturnType<typeof openPortalDb>) => T): T {
  const db = openPortalDb(config.dbPath);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('the audit trail (backlog #58)', () => {
  it('gives every transition its actor, and each download one event naming who took it', async () => {
    const { order, files } = await submitOrder(ada.accessToken, [
      { name: 'brief.txt', body: 'hello world' },
    ]);
    const admin = await adminLogin();
    const approved = await app.inject({
      method: 'POST',
      url: `/api/client/orders/${order.id}/approve`,
      headers: auth(ada.accessToken),
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const started = await app.inject({
      method: 'PATCH',
      url: `/api/admin/orders/${order.id}`,
      headers: auth(admin),
      payload: { status: 'in_progress' },
    });
    expect(started.statusCode, started.body).toBe(200);
    const { deliveredFiles } = await deliver(
      admin,
      order.id,
      [{ name: 'brief.es.txt', body: 'hola mundo' }],
      true,
    );
    const deliveredId = deliveredFiles[0]!.id;
    const sourceId = files[0]!.id;

    const clientDownload = await app.inject({
      method: 'GET',
      url: `/api/client/orders/${order.id}/delivered-files/${deliveredId}`,
      headers: auth(ada.accessToken),
    });
    expect(clientDownload.statusCode).toBe(200);
    const adminDownload = await app.inject({
      method: 'GET',
      url: `/api/admin/orders/${order.id}/source-files/${sourceId}`,
      headers: auth(admin),
    });
    expect(adminDownload.statusCode).toBe(200);
    // A refused download sends nothing, so it records nothing.
    const refused = await app.inject({
      method: 'GET',
      url: `/api/client/orders/${order.id}/delivered-files/${deliveredId}`,
      headers: auth(other.accessToken),
    });
    expect(refused.statusCode).toBe(404);

    const logs = readLogs((db) => ({
      transitions: listOrderEvents(db, order.id).map((e) => [
        e.toStatus,
        e.actor,
        e.actorLabel,
      ]),
      events: (['admin_user', 'source_file', 'delivered_file'] as const).flatMap((t) =>
        listEvents(db, { subjectType: t }).map((e) => ({
          action: e.action,
          actor: e.actor,
          label: e.actorLabel,
          subject: `${e.subjectType}:${e.subjectId}`,
          detail: e.detail === null ? null : (JSON.parse(e.detail) as unknown),
        })),
      ),
      verified: verifyAudit(db),
    }));

    const adminLabel = 'admin@example.com';
    expect(logs.transitions).toEqual([
      ['submitted', `client:${ada.id}`, null],
      ['approved', `client:${ada.id}`, null],
      ['in_progress', 'admin:1', adminLabel],
      ['delivered', 'admin:1', adminLabel],
    ]);
    expect(logs.events).toEqual([
      {
        action: 'auth.login',
        actor: 'admin:1',
        label: adminLabel,
        subject: 'admin_user:1',
        detail: null,
      },
      {
        action: 'file.downloaded',
        actor: 'admin:1',
        label: adminLabel,
        subject: `source_file:${sourceId}`,
        detail: { file_id: sourceId, name: 'brief.txt', sha256: sha256('hello world') },
      },
      {
        action: 'file.delivered',
        actor: 'admin:1',
        label: adminLabel,
        subject: `delivered_file:${deliveredId}`,
        detail: {
          order_id: order.id,
          name: 'brief.es.txt',
          sha256: sha256('hola mundo'),
        },
      },
      {
        action: 'file.downloaded',
        actor: `client:${ada.id}`,
        label: null,
        subject: `delivered_file:${deliveredId}`,
        detail: {
          file_id: deliveredId,
          name: 'brief.es.txt',
          sha256: sha256('hola mundo'),
        },
      },
    ]);
    expect(logs.verified).toEqual({ events: 4, brokenAt: null });
  });

  it('records a refused admin login as the gate, telling the reasons apart only in the log', async () => {
    for (const payload of [
      { email: 'admin@example.com', password: 'wrong' },
      { email: 'nobody@example.com', password: 'admin-pw' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid email or password' });
    }
    const events = readLogs((db) =>
      listEvents(db, { subjectType: 'admin_user' }).map((e) => [
        e.actor,
        e.subjectId,
        e.detail,
      ]),
    );
    expect(events).toEqual([
      ['system:login', '1', '{"reason":"wrong_password"}'],
      ['system:login', null, '{"reason":"unknown_email"}'],
    ]);
  });

  it('shows a client who acted on its order, never the admin behind the label', async () => {
    const { order } = await submitOrder(ada.accessToken, [{ name: 'a.txt', body: 'a' }]);
    const admin = await adminLogin();
    await app.inject({
      method: 'PATCH',
      url: `/api/admin/orders/${order.id}`,
      headers: auth(admin),
      payload: { status: 'cancelled' },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/client/orders/${order.id}`,
      headers: auth(ada.accessToken),
    });
    const { events } = res.json() as { events: Array<Record<string, unknown>> };
    expect(events.map((e) => e['actor'])).toEqual([`client:${ada.id}`, 'admin:1']);
    expect(events.every((e) => !('actorLabel' in e))).toBe(true);
  });
});

describe('who may download what', () => {
  it('answers another client, a stranger, and a file id from another order with 404 or 401', async () => {
    const admin = await adminLogin();
    const mine = await submitOrder(ada.accessToken, [{ name: 'a.txt', body: 'a' }]);
    const theirs = await submitOrder(other.accessToken, [{ name: 'b.txt', body: 'b' }]);
    const mineDelivered = await deliver(admin, mine.order.id, [
      { name: 'a.es.txt', body: 'A' },
    ]);
    const theirsDelivered = await deliver(admin, theirs.order.id, [
      { name: 'b.es.txt', body: 'B' },
    ]);
    const mineFile = mineDelivered.deliveredFiles[0]!.id;
    const theirsFile = theirsDelivered.deliveredFiles[0]!.id;

    // Ada gets her own file...
    const ok = await app.inject({
      method: 'GET',
      url: `/api/client/orders/${mine.order.id}/delivered-files/${mineFile}`,
      headers: auth(ada.accessToken),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('A');

    // ...and nobody else's — neither by order nor by mixing ids.
    const cases: Array<[string, string, number]> = [
      ['other client, their order', other.accessToken, 404],
      ['no token', '', 401],
      ['bogus token', 'nope', 401],
    ];
    for (const [label, token, status] of cases) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/client/orders/${mine.order.id}/delivered-files/${mineFile}`,
        headers: token ? auth(token) : {},
      });
      expect(res.statusCode, label).toBe(status);
    }
    const crossed = await app.inject({
      method: 'GET',
      url: `/api/client/orders/${mine.order.id}/delivered-files/${theirsFile}`,
      headers: auth(ada.accessToken),
    });
    expect(crossed.statusCode, 'own order, other order\u2019s file id').toBe(404);

    // Same on the admin side: a file id has to belong to the order named.
    const adminCrossed = await app.inject({
      method: 'GET',
      url: `/api/admin/orders/${mine.order.id}/source-files/${theirs.files[0]!.id}`,
      headers: auth(admin),
    });
    expect(adminCrossed.statusCode).toBe(404);
    const noAdmin = await app.inject({
      method: 'GET',
      url: `/api/admin/orders/${mine.order.id}/source-files/${mine.files[0]!.id}`,
      headers: auth(ada.accessToken),
    });
    expect(noAdmin.statusCode).toBe(401);
  });
});

describe('where uploaded bytes land', () => {
  it('never builds a path from the uploaded filename, and serves the file under its leaf name', async () => {
    const { order, files } = await submitOrder(ada.accessToken, [
      { name: '../../escape.txt', body: 'out?' },
      // (A quote in the name is covered by storage.test.ts — the WHATWG
      // FormData serializer percent-encodes it before the route sees it.)
      { name: 'C:\\Users\\ada\\r\u00e9sum\u00e9 (v2).txt', body: 'windows' },
      { name: 'plain.txt', body: 'plain' },
    ]);
    expect(files.map((f) => f.filename)).toEqual([
      'escape.txt',
      'r\u00e9sum\u00e9 (v2).txt',
      'plain.txt',
    ]);

    // Every byte is under orders/<id>/source/<minted name>: nothing
    // escaped the root, and no on-disk name is the client's.
    const stored = storedFiles();
    expect(stored).toHaveLength(3);
    for (const rel of stored) {
      expect(rel).toMatch(new RegExp(`^orders/${order.id}/source/[0-9a-f-]{36}$`, 'u'));
    }
    expect(existsSync(join(dir, 'escape.txt'))).toBe(false);
    expect(existsSync(join(config.storageRoot, 'escape.txt'))).toBe(false);

    const admin = await adminLogin();
    const res = await app.inject({
      method: 'GET',
      url: `/api/admin/orders/${order.id}/source-files/${files[1]!.id}`,
      headers: auth(admin),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('windows');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="r_sum_ (v2).txt"; filename*=UTF-8''r%C3%A9sum%C3%A9%20(v2).txt`,
    );
  });

  it('reports a file whose bytes are gone as a server error, not a 404', async () => {
    const { order, files } = await submitOrder(ada.accessToken, [
      { name: 'a.txt', body: 'a' },
    ]);
    rmSync(config.storageRoot, { recursive: true, force: true });
    const admin = await adminLogin();
    const res = await app.inject({
      method: 'GET',
      url: `/api/admin/orders/${order.id}/source-files/${files[0]!.id}`,
      headers: auth(admin),
    });
    expect(res.statusCode).toBe(500);
  });
});
