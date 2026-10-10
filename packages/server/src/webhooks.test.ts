/**
 * Signed webhooks for the vendor events (backlog #125; vendor-spec.md, its #125
 * note), through Fastify's `inject` with a fake sender and resolver: an owner
 * registers an endpoint, assignment events queue in the roster file beside the
 * events themselves, the dispatcher drains them, and nothing but ids and states
 * leaves. The HTTPS sender is tested apart, against a fake client.
 */

import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashPassword, type AuditActor } from '@cat-tool/core';
import {
  addRosterMembership,
  addVendor,
  createAccount,
  createVendorFile,
  openPlatformDb,
  openVendorFile,
  type Account,
  type DueWebhook,
  type WebhookAttempt,
} from '@cat-tool/db';
import { verifyWebhookSignature } from '@cat-tool/vendor-core/webhook';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from './app.js';
import type { ServerConfig } from './config.js';
import { createWebhookSender, vetHost } from './webhook-send.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/docx/form-minimal.docx',
);
const SETUP: AuditActor = { actor: { kind: 'system', name: 'test-setup' }, label: null };
const PUBLIC = '93.184.216.34';
const URL1 = 'https://hooks.example.com/in/abc?token=hunter2';

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;
let alice: Account; // an owner
let bob: Account; // a vendor on alice's roster
let erin: Account; // another owner

const sent: Array<{ delivery: DueWebhook; at: Date | undefined }> = [];
let answer: (d: DueWebhook) => WebhookAttempt = () => ({
  ok: true,
  httpStatus: 200,
  error: null,
});
const send = async (delivery: DueWebhook, at?: Date): Promise<WebhookAttempt> => {
  sent.push({ delivery, at });
  return answer(delivery);
};
const resolve = async (host: string): Promise<string[]> => {
  if (host === 'private.example.com') return ['10.0.0.5'];
  if (host === 'mixed.example.com') return [PUBLIC, '169.254.169.254'];
  if (host === 'gone.example.com') throw new Error('ENOTFOUND');
  return [PUBLIC];
};

// The dispatcher's clock: tests move it to make a deadline approach or pass.
let clock: Date | null = null;
const clockNow = () => clock ?? new Date();

async function open(tickMs = 10): Promise<FastifyInstance> {
  return buildApp({
    config,
    logger: false,
    webhooks: { send, resolve, tickMs, now: clockNow },
  });
}

beforeEach(async () => {
  sent.length = 0;
  clock = null;
  answer = () => ({ ok: true, httpStatus: 200, error: null });
  dir = mkdtempSync(join(tmpdir(), 'cat-webhooks-srv-'));
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
  erin = make('erin');
  addRosterMembership(platform, { ownerId: alice.id, accountId: bob.id });
  platform.close();
  const rosterPath = join(config.storageRoot, alice.storageRoot, 'vendors.ctv');
  mkdirSync(dirname(rosterPath), { recursive: true });
  const roster = createVendorFile(rosterPath, { generator: 'test' });
  addVendor(roster, { accountId: bob.id, actor: SETUP });
  roster.close();
  app = await open();
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
const register = (token: string, url: string) =>
  app.inject({
    method: 'POST',
    url: '/api/webhooks',
    headers: as(token),
    payload: { url },
  });
const list = async (token: string) =>
  (await app.inject({ method: 'GET', url: '/api/webhooks', headers: as(token) })).json<{
    webhooks: Array<Record<string, unknown>>;
  }>().webhooks;

async function aliceWithProject(): Promise<string> {
  const token = await login('alice');
  await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: as(token),
    payload: { name: 'client-acme-brochure', srcLang: 'en', tgtLang: 'de' },
  });
  const form = new FormData();
  form.append('file', new Blob([readFileSync(FIXTURE)]), 'form-minimal.docx');
  await app.inject({
    method: 'POST',
    url: '/api/projects/client-acme-brochure/files',
    headers: as(token),
    payload: form,
  });
  return token;
}

const settled = (n: number) =>
  vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(n), {
    timeout: 4000,
    interval: 10,
  });

describe('registering an endpoint', () => {
  it('returns the secret once; the list shows the host, never the secret or the token', async () => {
    const a = await login('alice');
    const res = await register(a, URL1);
    expect(res.statusCode, res.body).toBe(201);
    const { webhook, secret } = res.json<{
      webhook: { id: number; host: string };
      secret: string;
    }>();
    expect(webhook.host).toBe('hooks.example.com');
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const listed = await app.inject({
      method: 'GET',
      url: '/api/webhooks',
      headers: as(a),
    });
    expect(listed.body).toContain('hooks.example.com');
    expect(listed.body).not.toContain(secret);
    expect(listed.body).not.toContain('hunter2');
  });

  it.each([
    ['plain http', 'http://hooks.example.com/'],
    ['an IP literal', 'https://93.184.216.34/'],
    ['a port', 'https://hooks.example.com:8443/'],
    ['user info', 'https://u:p@hooks.example.com/'],
    ['a name that resolves to a private address', 'https://private.example.com/'],
    ['a name with a private address among its answers', 'https://mixed.example.com/'],
    ['a name that does not resolve', 'https://gone.example.com/'],
  ])('refuses %s', async (_name, url) => {
    const a = await login('alice');
    const res = await register(a, url);
    expect(res.statusCode, res.body).toBe(400);
    expect(await list(a)).toEqual([]);
  });

  it('allows three endpoints, refuses a fourth, and removes one (404 the second time)', async () => {
    const a = await login('alice');
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await register(a, `https://h${i}.example.com/`);
      expect(r.statusCode).toBe(201);
      ids.push(r.json<{ webhook: { id: number } }>().webhook.id);
    }
    expect((await register(a, 'https://h9.example.com/')).statusCode).toBe(400);
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/webhooks/${ids[0]}`,
      headers: as(a),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ removed: true });
    const again = await app.inject({
      method: 'DELETE',
      url: `/api/webhooks/${ids[0]}`,
      headers: as(a),
    });
    expect(again.statusCode).toBe(404);
    expect(await list(a)).toHaveLength(2);
  });

  it('is an owner’s alone, and one owner never sees another’s', async () => {
    const a = await login('alice');
    expect((await register(a, URL1)).statusCode).toBe(201);
    const b = await login('bob');
    for (const probe of [
      app.inject({ method: 'GET', url: '/api/webhooks', headers: as(b) }),
      register(b, URL1),
      app.inject({ method: 'POST', url: '/api/webhooks/1/test', headers: as(b) }),
      app.inject({ method: 'DELETE', url: '/api/webhooks/1', headers: as(b) }),
    ]) {
      expect((await probe).statusCode).toBe(403);
    }
    const e = await login('erin');
    expect(await list(e)).toEqual([]);
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/webhooks/1', headers: as(e) }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: '/api/webhooks/1/test', headers: as(e) }))
        .statusCode,
    ).toBe(404);
    expect(await list(a)).toHaveLength(1);
  });

  it('needs a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/webhooks' })).statusCode).toBe(
      401,
    );
  });
});

describe('delivery', () => {
  it('sends the events in order, signed, with ids and states only, then shows them delivered', async () => {
    const a = await aliceWithProject();
    const reg = await register(a, URL1);
    const { secret } = reg.json<{ secret: string }>();
    const offer = await app.inject({
      method: 'POST',
      url: '/api/assignments',
      headers: as(a),
      payload: {
        project: 'client-acme-brochure',
        channel: 'direct',
        vendors: [bob.id],
        instructions: 'Formal register for the Acme account.',
      },
    });
    expect(offer.statusCode, offer.body).toBe(201);
    const id = offer.json<{ assignment: { id: number } }>().assignment.id;
    const b = await login('bob');
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/assignments/${id}/accept?owner=${alice.id}`,
      headers: as(b),
    });
    expect(accepted.statusCode, accepted.body).toBe(200);

    await settled(2);
    expect(sent.map((s) => s.delivery.eventType)).toEqual([
      'assignment.offered',
      'assignment.accepted',
    ]);
    const second = JSON.parse(sent[1]!.delivery.body);
    expect(second).toMatchObject({
      assignmentId: id,
      from: 'offered',
      to: 'accepted',
      vendorAccountId: bob.id,
    });
    for (const s of sent) {
      expect(s.delivery.body).not.toMatch(/acme|formal|brochure|@example/i);
      expect(s.delivery.secret).toBe(secret);
      expect(s.delivery.url).toBe(URL1);
    }
    await vi.waitFor(async () =>
      expect((await list(a))[0]).toMatchObject({
        delivered: 2,
        pending: 0,
        failed: 0,
        lastStatus: 200,
      }),
    );
  });

  it('keeps a failed delivery pending for a retry, with its last status', async () => {
    const a = await aliceWithProject();
    await register(a, URL1);
    answer = () => ({ ok: false, httpStatus: 503, error: 'http' });
    await app.inject({
      method: 'POST',
      url: '/api/assignments',
      headers: as(a),
      payload: { project: 'client-acme-brochure', channel: 'direct', vendors: [bob.id] },
    });
    await settled(1);
    await vi.waitFor(async () =>
      expect((await list(a))[0]).toMatchObject({
        pending: 1,
        delivered: 0,
        lastStatus: 503,
      }),
    );
    // not tried again at once: the next attempt is a minute away
    const tries = sent.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(sent.length).toBe(tries);
  });

  it('sends a test ping on request', async () => {
    const a = await login('alice');
    const id = (await register(a, URL1)).json<{ webhook: { id: number } }>().webhook.id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/${id}/test`,
      headers: as(a),
    });
    expect(res.statusCode).toBe(202);
    await settled(1);
    expect(sent[0]!.delivery.eventType).toBe('ping');
    expect(JSON.parse(sent[0]!.delivery.body)).toMatchObject({
      type: 'ping',
      assignmentId: null,
      vendorAccountId: null,
    });
  });

  it('carries on after a restart: the queue is in the roster, not in memory', async () => {
    const a = await aliceWithProject();
    await register(a, URL1);
    await app.close();
    // an app that queues but never drains (no timer, no nudge): the rows wait in the file
    app = await open(0);
    const a2 = await login('alice');
    await app.inject({
      method: 'POST',
      url: '/api/assignments',
      headers: as(a2),
      payload: { project: 'client-acme-brochure', channel: 'direct', vendors: [bob.id] },
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(sent).toHaveLength(0);
    const rosterPath = join(config.storageRoot, alice.storageRoot, 'vendors.ctv');
    const roster = openVendorFile(rosterPath);
    const waiting = (
      roster
        .prepare(`SELECT COUNT(*) AS n FROM webhook_delivery WHERE status = 'pending'`)
        .get() as {
        n: number;
      }
    ).n;
    roster.close();
    expect(waiting).toBe(1);

    await app.close();
    app = await open(10); // boot finds the owner with pending rows and drains them
    await settled(1);
    expect(sent[0]!.delivery.eventType).toBe('assignment.offered');
  });

  it('leaves another owner’s roster alone', async () => {
    const a = await aliceWithProject();
    await register(a, URL1);
    const e = await login('erin');
    expect(await list(e)).toEqual([]);
    await app.inject({
      method: 'POST',
      url: '/api/assignments',
      headers: as(a),
      payload: { project: 'client-acme-brochure', channel: 'direct', vendors: [bob.id] },
    });
    await settled(1);
    expect(sent.every((s) => s.delivery.url === URL1)).toBe(true);
    expect(erin.id).not.toBe(alice.id);
  });
});

describe('the deadline clock', () => {
  const DAY = 86_400_000;
  /** Offers a job due in two days and returns the deadline's instant. */
  async function offerDue(token: string): Promise<number> {
    const due = Date.now() + 2 * DAY;
    const res = await app.inject({
      method: 'POST',
      url: '/api/assignments',
      headers: as(token),
      payload: {
        project: 'client-acme-brochure',
        channel: 'direct',
        vendors: [bob.id],
        deadline: new Date(due).toISOString(),
      },
    });
    expect(res.statusCode).toBe(201);
    return due;
  }
  const types = () => sent.map((s) => s.delivery.eventType);

  it('sends a reminder inside the lead window and overdue after the deadline, once each', async () => {
    const a = await aliceWithProject();
    await register(a, URL1);
    const due = await offerDue(a);
    await settled(1);
    expect(types()).toEqual(['assignment.offered']);

    clock = new Date(due - 12 * 3_600_000);
    await settled(2);
    expect(types()).toEqual(['assignment.offered', 'assignment.deadline_soon']);
    const soon = JSON.parse(sent[1]!.delivery.body);
    expect(soon).toMatchObject({
      type: 'assignment.deadline_soon',
      from: null,
      to: 'offered',
      vendorAccountId: bob.id,
    });
    // the body names the job by id and state, never by project or deadline
    expect(sent[1]!.delivery.body).not.toMatch(/acme|brochure|deadline"/i);

    clock = new Date(due + 60_000);
    await settled(3);
    expect(types().at(-1)).toBe('assignment.overdue');
    await new Promise((r) => setTimeout(r, 80));
    expect(types()).toHaveLength(3); // nothing repeats on later ticks
  });

  it('reminds nobody when the owner turns the lead off, but still reports overdue', async () => {
    const a = await aliceWithProject();
    await register(a, URL1);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/webhooks/reminders',
      headers: as(a),
      payload: { leadHours: 0 },
    });
    expect(put.json()).toEqual({ leadHours: 0 });
    const due = await offerDue(a);
    await settled(1);

    clock = new Date(due - 12 * 3_600_000);
    await new Promise((r) => setTimeout(r, 80));
    expect(types()).toEqual(['assignment.offered']);

    clock = new Date(due + 60_000);
    await settled(2);
    expect(types()).toEqual(['assignment.offered', 'assignment.overdue']);
  });

  it('picks up a deadline that came due while the server was down', async () => {
    const a = await aliceWithProject();
    await register(a, URL1);
    const due = await offerDue(a);
    await settled(1);
    await app.close();
    sent.length = 0;

    clock = new Date(due + DAY); // started again a day after the deadline
    app = await open(10);
    await settled(1);
    // the reminder is superseded: only the overdue notice goes out
    expect(types()).toEqual(['assignment.overdue']);
  });

  it('reads and sets the lead for an owner only, refusing anything but whole hours 0 to 720', async () => {
    const a = await login('alice');
    const get = (t: string) =>
      app.inject({ method: 'GET', url: '/api/webhooks/reminders', headers: as(t) });
    const put = (t: string, leadHours: unknown) =>
      app.inject({
        method: 'PUT',
        url: '/api/webhooks/reminders',
        headers: as(t),
        payload: { leadHours },
      });
    expect((await get(a)).json()).toEqual({ leadHours: 24 });
    expect((await put(a, 48)).json()).toEqual({ leadHours: 48 });
    expect((await get(a)).json()).toEqual({ leadHours: 48 });
    for (const bad of [-1, 721, 1.5, '24', null]) {
      expect((await put(a, bad)).statusCode).toBe(400);
    }
    const b = await login('bob');
    expect((await get(b)).statusCode).toBe(403);
    expect((await put(b, 1)).statusCode).toBe(403);
    expect((await get(a)).json()).toEqual({ leadHours: 48 });
  });
});

describe('the HTTPS sender', () => {
  const delivery = (over: Partial<DueWebhook> = {}): DueWebhook => ({
    id: 'd-1',
    endpointId: 1,
    url: 'https://hooks.example.com/in/abc?token=t',
    secret: 's3cret-s3cret-s3cret-s3cret-s3cret-abc',
    eventType: 'assignment.accepted',
    body: JSON.stringify({ id: 'uuid-1', type: 'assignment.accepted' }),
    attempts: 0,
    ...over,
  });

  /** The options a request was made with, as far as these tests read them. */
  interface Captured {
    method: string;
    hostname: string;
    path: string;
    headers: Record<string, string>;
    lookup: (
      host: string,
      options: object,
      callback: (e: unknown, address: string, family: number) => void,
    ) => void;
    body: string;
  }

  /** A fake `https.request` that records its options and plays one response. */
  function fakeClient(plan: { status?: number; never?: boolean; error?: Error } = {}) {
    const calls: Captured[] = [];
    const request = ((
      options: Captured,
      cb: (res: EventEmitter & { statusCode?: number; destroy(): void }) => void,
    ) => {
      calls.push(options);
      const req = new EventEmitter() as EventEmitter & {
        end(body: string): void;
        destroy(): void;
        written?: string;
      };
      req.destroy = () => undefined;
      req.end = (body: string) => {
        req.written = body;
        calls[calls.length - 1]!.body = body;
        if (plan.never) return;
        setImmediate(() => {
          if (plan.error) {
            req.emit('error', plan.error);
            return;
          }
          const res = new EventEmitter() as EventEmitter & {
            statusCode?: number;
            destroy(): void;
          };
          res.statusCode = plan.status ?? 200;
          res.destroy = () => undefined;
          cb(res);
          res.emit('end');
        });
      };
      return req;
    }) as never;
    return { request, calls };
  }
  const deps = (client: ReturnType<typeof fakeClient>, extra = {}) => ({
    resolve,
    request: client.request,
    timeoutMs: 40,
    ...extra,
  });

  it('dials the address it checked, keeps the host name, and signs what it sends', async () => {
    const client = fakeClient();
    const now = new Date('2026-03-01T10:00:00Z');
    const outcome = await createWebhookSender(deps(client))(delivery(), now);
    expect(outcome).toEqual({ ok: true, httpStatus: 200, error: null });
    const call = client.calls[0]!;
    expect(call).toMatchObject({
      method: 'POST',
      hostname: 'hooks.example.com',
      path: '/in/abc?token=t',
    });
    let pinned: unknown;
    call.lookup(
      'hooks.example.com',
      {},
      (_e: unknown, address: string, family: number) => {
        pinned = [address, family];
      },
    );
    expect(pinned).toEqual([PUBLIC, 4]);
    expect(call.headers['x-tessera-event']).toBe('assignment.accepted');
    expect(call.headers['x-tessera-delivery']).toBe('uuid-1');
    expect(call.headers['user-agent']).toBe('Tessera-Webhooks/1');
    expect(
      verifyWebhookSignature(
        delivery().secret,
        call.headers['x-tessera-signature']!,
        call.body,
        Math.floor(now.getTime() / 1000),
      ),
    ).toBe(true);
    expect(call.body).toBe(delivery().body);
  });

  it('never calls a name that resolves to a private address, or to one among several', async () => {
    for (const host of ['private.example.com', 'mixed.example.com']) {
      const client = fakeClient();
      const outcome = await createWebhookSender(deps(client))(
        delivery({ url: `https://${host}/x` }),
      );
      expect(outcome).toMatchObject({ ok: false, error: 'address' });
      expect(client.calls).toHaveLength(0);
    }
  });

  it('refuses a stored URL that is no longer acceptable, without resolving it', async () => {
    const client = fakeClient();
    const resolver = vi.fn(resolve);
    const sender = createWebhookSender({ ...deps(client), resolve: resolver });
    for (const url of [
      'http://hooks.example.com/',
      'https://127.0.0.1/',
      'https://h.example.com:8443/',
    ]) {
      expect(await sender(delivery({ url }))).toMatchObject({ ok: false, error: 'url' });
    }
    expect(resolver).not.toHaveBeenCalled();
    expect(client.calls).toHaveLength(0);
  });

  it('says dns when the name does not resolve', async () => {
    const client = fakeClient();
    expect(
      await createWebhookSender(deps(client))(
        delivery({ url: 'https://gone.example.com/' }),
      ),
    ).toMatchObject({ ok: false, error: 'dns' });
  });

  it.each([
    [200, true, null],
    [204, true, null],
    [301, false, 'redirect'],
    [302, false, 'redirect'],
    [400, false, 'http'],
    [410, false, 'http'],
    [500, false, 'http'],
  ])('reads a %i answer, and never follows a redirect', async (status, ok, error) => {
    const client = fakeClient({ status });
    const outcome = await createWebhookSender(deps(client))(delivery());
    expect(outcome).toEqual({ ok, httpStatus: status, error });
    expect(client.calls).toHaveLength(1); // one request: the Location is not followed
  });

  it('times out a receiver that never answers', async () => {
    const outcome = await createWebhookSender(deps(fakeClient({ never: true })))(
      delivery(),
    );
    expect(outcome).toMatchObject({ ok: false, error: 'timeout' });
  });

  it('names a refused connection and a certificate problem without keeping the message', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 93.184.216.34:443'), {
      code: 'ECONNREFUSED',
    });
    expect(
      await createWebhookSender(deps(fakeClient({ error: refused })))(delivery()),
    ).toMatchObject({ error: 'refused' });
    const tls = new Error('self-signed certificate');
    expect(
      await createWebhookSender(deps(fakeClient({ error: tls })))(delivery()),
    ).toMatchObject({ error: 'tls' });
  });

  it('vets a host by every address it resolves to', async () => {
    expect(await vetHost('ok.example.com', { resolve })).toEqual({
      ok: true,
      address: PUBLIC,
    });
    expect(await vetHost('private.example.com', { resolve })).toMatchObject({
      ok: false,
    });
    expect(await vetHost('mixed.example.com', { resolve })).toMatchObject({ ok: false });
    expect(await vetHost('x.example.com', { resolve: async () => [] })).toMatchObject({
      ok: false,
    });
  });
});
