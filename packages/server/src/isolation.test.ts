/**
 * The isolation matrix (backlog #207, `planning/tenant-spec.md` §6 invariant 1): a session
 * of tenant A, on **every route the app registers**, against tenant B's project, memory,
 * glossary, roster, job, assignment, webhook, invitation, staff and consent, gets the
 * response a missing object gets: the same status and the same body.
 *
 * The routes are listed by the app itself (`onRoute`), never by hand, and each is looked up
 * in `ROUTES` below. A route registered without an entry fails `every route is classified`,
 * and an entry for a route that no longer exists fails it too. Every `/api/projects/:name`
 * route is probed without an entry, because a project route is exactly what the rule is
 * about: it is walked with B's project name and with `?tenant=<B>` (which only a grant
 * opens) and compared with a project nobody has.
 *
 * Two things keep a green run from meaning less than it says. A probe's control (the
 * missing object) must itself be a 404, so a request that is turned back by body
 * validation, which is the same for B's object and for a missing one, fails the test and
 * is given a body that gets past it. And after every probe has run, tenant B's own view of
 * its data is unchanged, which catches a write that answered 404 and happened anyway.
 *
 * The accounts are made so no tenant id equals its founder's account id.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashPassword, type AuditActor } from '@cat-tool/core';
import {
  addVendor,
  createAccount,
  createVendorFile,
  getTenantForAccount,
  openPlatformDb,
  type Account,
  type Tenant,
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
const PUBLIC_ADDRESS = '93.184.216.34';

let dir: string;
let config: ServerConfig;
let app: FastifyInstance;
let routes: string[];
let carol: Account; // admin of tenant B, the owner of every object probed
let zed: Account; // a vendor on B's roster
let tenantB: Tenant;

/** What tenant B holds: the ids and names the probes ask for, and markers a list must not show. */
interface World {
  readonly project: string;
  readonly fileId: number;
  readonly segmentId: number;
  readonly tm: string;
  readonly jobId: string;
  readonly webhookId: number;
  readonly vendorInvitationId: number;
  readonly staffInvitationId: number;
  readonly assignmentId: number;
  readonly clientId: number;
  readonly markers: readonly string[];
}
let world: World;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-isolation-'));
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
  make('bob', 'vendor'); // a vendor first, so no tenant id equals its founder's account id
  make('alice'); // admin of tenant A, the session that probes
  carol = make('carol');
  zed = make('zed', 'vendor');
  tenantB = getTenantForAccount(platform, carol.id)!.tenant;
  platform.close();

  const rosterPath = join(config.storageRoot, tenantB.storageRoot, 'vendors.ctv');
  mkdirSync(dirname(rosterPath), { recursive: true });
  const roster = createVendorFile(rosterPath, { generator: 'test' });
  addVendor(roster, { accountId: zed.id, actor: SETUP });
  roster.close();

  routes = [];
  app = await buildApp({
    config,
    logger: false,
    onRoute: (r) => routes.push(`${r.method} ${r.url}`),
    webhooks: {
      send: async () => ({ ok: true, httpStatus: 200, error: null }),
      resolve: async () => [PUBLIC_ADDRESS],
      tickMs: 0,
    },
  });
  world = await buildWorld();
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

// --- requests ----------------------------------------------------------

interface Req {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly url: string;
  readonly body?: unknown;
}
interface Res {
  readonly status: number;
  readonly body: string;
}

async function login(name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email: `${name}@example.com`, password: `${name}-pw` },
  });
  return (res.json() as { token: string }).token;
}

async function send(token: string, req: Req): Promise<Res> {
  const res = await app.inject({
    method: req.method,
    url: req.url,
    headers: { authorization: `Bearer ${token}` },
    ...(req.body === undefined ? {} : { payload: req.body as object }),
  });
  return { status: res.statusCode, body: res.body };
}

async function sendOk<T>(token: string, req: Req, expected: number): Promise<T> {
  const res = await send(token, req);
  expect(res.status, `${req.method} ${req.url}: ${res.body}`).toBe(expected);
  return JSON.parse(res.body) as T;
}

const TMX =
  '<?xml version="1.0" encoding="UTF-8"?><tmx version="1.4"><header srclang="en" segtype="sentence" datatype="plaintext" adminlang="en" creationtool="t" creationtoolversion="1" o-tmf="t"/><body><tu><tuv xml:lang="en"><seg>Hello</seg></tuv><tuv xml:lang="de"><seg>Hallo</seg></tuv></tu></body></tmx>';

/** Gives tenant B one of each thing a route can name. */
async function buildWorld(): Promise<World> {
  const c = await login('carol');
  await sendOk(
    c,
    {
      method: 'POST',
      url: '/api/projects',
      body: { name: 'b-job', srcLang: 'en', tgtLang: 'de' },
    },
    201,
  );
  const form = new FormData();
  form.append('file', new Blob([readFileSync(FIXTURE)]), 'form-minimal.docx');
  const upload = await app.inject({
    method: 'POST',
    url: '/api/projects/b-job/files',
    headers: { authorization: `Bearer ${c}` },
    payload: form,
  });
  expect(upload.statusCode, upload.body).toBe(201);
  const fileId = (upload.json() as { file: { id: number } }).file.id;
  const segments = await sendOk<{ segments: Array<{ id: number }> }>(
    c,
    { method: 'GET', url: `/api/projects/b-job/files/${fileId}/segments` },
    200,
  );
  const segmentId = segments.segments[0]!.id;

  const tmForm = new FormData();
  tmForm.append('name', 'b-tm');
  tmForm.append('file', new Blob([TMX]), 'mem.tmx');
  const imported = await app.inject({
    method: 'POST',
    url: '/api/tms',
    headers: { authorization: `Bearer ${c}` },
    payload: tmForm,
  });
  expect(imported.statusCode, imported.body).toBe(202);
  const jobId = (imported.json() as { job: { id: string } }).job.id;
  for (let i = 0; i < 100; i++) {
    const job = await sendOk<{ state: string }>(
      c,
      { method: 'GET', url: `/api/jobs/${jobId}` },
      200,
    );
    if (job.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 50));
  }

  await sendOk(
    c,
    { method: 'POST', url: '/api/glossaries', body: { name: 'b-gl' } },
    201,
  );
  const hook = await sendOk<{ webhook: { id: number } }>(
    c,
    {
      method: 'POST',
      url: '/api/webhooks',
      body: { url: 'https://hooks.example.com/b-hook' },
    },
    201,
  );
  const vendorInvite = await sendOk<{ invitation: { id: number } }>(
    c,
    { method: 'POST', url: '/api/invitations', body: { email: 'b-vendor@example.com' } },
    201,
  );
  const staffInvite = await sendOk<{ invitation: { id: number } }>(
    c,
    {
      method: 'POST',
      url: '/api/staff/invitations',
      body: { email: 'b-staff@example.com', role: 'pm' },
    },
    201,
  );
  const clientId = 7;
  await sendOk(
    c,
    {
      method: 'PUT',
      url: `/api/clients/${clientId}/engine`,
      body: { consent: { tessera: true } },
    },
    200,
  );
  const offered = await sendOk<{ assignment: { id: number } }>(
    c,
    {
      method: 'POST',
      url: '/api/assignments',
      body: {
        project: 'b-job',
        channel: 'direct',
        vendors: [zed.id],
        deadline: '2026-03-10T17:00:00Z',
        instructions: 'Formal register.',
      },
    },
    201,
  );
  return {
    project: 'b-job',
    fileId,
    segmentId,
    tm: 'b-tm',
    jobId,
    webhookId: hook.webhook.id,
    vendorInvitationId: vendorInvite.invitation.id,
    staffInvitationId: staffInvite.invitation.id,
    assignmentId: offered.assignment.id,
    clientId,
    markers: [
      'b-job',
      'b-tm',
      'b-gl',
      'b-hook',
      'b-vendor@',
      'b-staff@',
      'carol@',
      'zed@',
    ],
  };
}

// --- the table ---------------------------------------------------------

/** A request for B's object, and the same request for one that does not exist. */
interface Pair {
  readonly actual: Req;
  readonly missing: Req;
  /** What B's id looks like in `actual`'s answer, if it is echoed; replaced by the control's before comparing. */
  readonly echo?: readonly [actual: string, missing: string];
  /** What the control answers: 404 unless a missing object is not an error (a client number is a plain default). */
  readonly status?: number;
}

type Entry =
  | { readonly kind: 'public'; readonly why: string }
  | { readonly kind: 'own'; readonly why: string; readonly req?: Req }
  | { readonly kind: 'list' }
  | { readonly kind: 'object'; readonly pairs: (w: World) => Pair[] };

/** `?tenant=<B>` is the one thing a request names, and only a grant opens it. */
const asTenantB = (url: string): string =>
  `${url}${url.includes('?') ? '&' : '?'}tenant=${tenantB.id}`;

const assignmentVerbs = [
  'accept',
  'claim',
  'decline',
  'deliver',
  'payment',
  'payment/reopen',
  'review',
  'start',
] as const;

const ROUTES: Record<string, Entry> = {
  // Before a session exists, or about nothing but the session's own account.
  'POST /api/login': { kind: 'public', why: 'no session yet' },
  'POST /api/invitations/open': { kind: 'public', why: 'a link, not a session' },
  'POST /api/invitations/accept': { kind: 'public', why: 'a link, not a session' },
  'POST /api/staff-invitations/open': { kind: 'public', why: 'a link, not a session' },
  'POST /api/staff-invitations/accept': { kind: 'public', why: 'a link, not a session' },
  'POST /api/invitations/join': {
    kind: 'own',
    why: 'the signed-in account joins by a link; a link is the tenant’s own',
    req: { method: 'POST', url: '/api/invitations/join', body: { token: 'nope' } },
  },
  'POST /api/logout': { kind: 'own', why: 'ends the caller’s own session' },
  'GET /api/me': { kind: 'own', why: 'the caller’s own account' },

  // Lists and reads that name no object: they must not show B's.
  'GET /api/projects': { kind: 'list' },
  'GET /api/tms': { kind: 'list' },
  'GET /api/glossaries': { kind: 'list' },
  'GET /api/jobs': { kind: 'list' },
  'GET /api/invitations': { kind: 'list' },
  'GET /api/staff': { kind: 'list' },
  'GET /api/webhooks': { kind: 'list' },
  'GET /api/webhooks/reminders': { kind: 'list' },
  'GET /api/vendors': { kind: 'list' },
  'GET /api/vendors/eligibility': { kind: 'list' },
  'GET /api/assignments': { kind: 'list' },
  'GET /api/client-pools': { kind: 'list' },
  'GET /api/payables': { kind: 'list' },
  'GET /api/payables.csv': { kind: 'list' },
  'GET /api/vendor/feed': { kind: 'list' },
  'GET /api/vendor/capacity': { kind: 'list' },
  'GET /api/vendor/job': { kind: 'list' },
  'GET /api/vendor/payments': { kind: 'list' },

  // Writes that name no object of B's: they act on the caller's own tenant. Sent with
  // nothing that would make one valid, they cannot make anything in B; the snapshot after
  // the run proves B is unchanged.
  'POST /api/projects': {
    kind: 'own',
    why: 'creates in the caller’s tenant',
    req: {
      method: 'POST',
      url: '/api/projects',
      body: { name: 'b-job', srcLang: 'en', tgtLang: 'de' },
    },
  },
  'POST /api/tms': {
    kind: 'own',
    why: 'imports into the caller’s tenant',
    req: { method: 'POST', url: '/api/tms', body: {} },
  },
  'POST /api/glossaries': {
    kind: 'own',
    why: 'creates in the caller’s tenant',
    req: { method: 'POST', url: '/api/glossaries', body: { name: 'b-gl' } },
  },
  'POST /api/vendors': {
    kind: 'own',
    why: 'adds to the caller’s roster',
    req: { method: 'POST', url: '/api/vendors', body: { account: 1 } },
  },
  'POST /api/invitations': {
    kind: 'own',
    why: 'invites for the caller’s tenant',
    req: { method: 'POST', url: '/api/invitations', body: { email: 'x@example.com' } },
  },
  'POST /api/staff/invitations': {
    kind: 'own',
    why: 'invites for the caller’s tenant',
    req: {
      method: 'POST',
      url: '/api/staff/invitations',
      body: { email: 'x@example.com', role: 'pm' },
    },
  },
  'POST /api/webhooks': {
    kind: 'own',
    why: 'registers for the caller’s tenant',
    req: {
      method: 'POST',
      url: '/api/webhooks',
      body: { url: 'https://hooks.example.com/a' },
    },
  },
  'PUT /api/webhooks/reminders': {
    kind: 'own',
    why: 'sets the caller’s tenant’s lead time',
    req: { method: 'PUT', url: '/api/webhooks/reminders', body: { leadHours: 5 } },
  },
  'PUT /api/vendor/capacity': {
    kind: 'own',
    why: 'the vendor’s own capacity',
    req: { method: 'PUT', url: '/api/vendor/capacity', body: {} },
  },
  'POST /api/assignments/reconcile': {
    kind: 'own',
    why: 'mends the caller’s tenant’s grants',
    req: { method: 'POST', url: '/api/assignments/reconcile' },
  },
  'POST /api/assignments': {
    kind: 'object',
    pairs: (w) => [
      {
        actual: { method: 'POST', url: '/api/assignments', body: offer(w.project) },
        missing: { method: 'POST', url: '/api/assignments', body: offer('b-ghost') },
        echo: [w.project, 'b-ghost'],
      },
    ],
  },

  // An id or a name of B's, against one nobody has.
  'GET /api/jobs/:id': jobEntry('GET'),
  'DELETE /api/jobs/:id': jobEntry('DELETE'),
  'POST /api/tms/:slug/stale-scan': {
    kind: 'object',
    pairs: (w) => [
      {
        actual: {
          method: 'POST',
          url: `/api/tms/${w.tm}/stale-scan`,
          body: { glossary: 'b-gl', srcLang: 'en', tgtLang: 'de' },
        },
        missing: {
          method: 'POST',
          url: '/api/tms/b-gone/stale-scan',
          body: { glossary: 'b-gl', srcLang: 'en', tgtLang: 'de' },
        },
        echo: [w.tm, 'b-gone'],
      },
    ],
  },
  'DELETE /api/webhooks/:id': {
    kind: 'object',
    pairs: (w) => [
      {
        actual: { method: 'DELETE', url: `/api/webhooks/${w.webhookId}` },
        missing: { method: 'DELETE', url: '/api/webhooks/9999' },
        echo: [String(w.webhookId), '9999'],
      },
    ],
  },
  'POST /api/webhooks/:id/test': {
    kind: 'object',
    pairs: (w) => [
      {
        actual: { method: 'POST', url: `/api/webhooks/${w.webhookId}/test` },
        missing: { method: 'POST', url: '/api/webhooks/9999/test' },
        echo: [String(w.webhookId), '9999'],
      },
    ],
  },
  'POST /api/invitations/:id/revoke': {
    kind: 'object',
    pairs: (w) => [
      {
        actual: {
          method: 'POST',
          url: `/api/invitations/${w.vendorInvitationId}/revoke`,
        },
        missing: { method: 'POST', url: '/api/invitations/9999/revoke' },
        echo: [String(w.vendorInvitationId), '9999'],
      },
    ],
  },
  'POST /api/staff/invitations/:id/revoke': {
    kind: 'object',
    pairs: (w) => [
      {
        actual: {
          method: 'POST',
          url: `/api/staff/invitations/${w.staffInvitationId}/revoke`,
        },
        missing: { method: 'POST', url: '/api/staff/invitations/9999/revoke' },
        echo: [String(w.staffInvitationId), '9999'],
      },
    ],
  },
  'PUT /api/staff/:accountId': {
    kind: 'object',
    pairs: () => [
      {
        actual: { method: 'PUT', url: `/api/staff/${carol.id}`, body: { role: 'pm' } },
        missing: { method: 'PUT', url: '/api/staff/9999', body: { role: 'pm' } },
        echo: [String(carol.id), '9999'],
      },
    ],
  },
  'DELETE /api/staff/:accountId': {
    kind: 'object',
    pairs: () => [
      {
        actual: { method: 'DELETE', url: `/api/staff/${carol.id}` },
        missing: { method: 'DELETE', url: '/api/staff/9999' },
        echo: [String(carol.id), '9999'],
      },
    ],
  },
  'GET /api/vendors/:accountId/rates': {
    kind: 'object',
    pairs: () => [
      {
        actual: { method: 'GET', url: `/api/vendors/${zed.id}/rates` },
        missing: { method: 'GET', url: '/api/vendors/9999/rates' },
        echo: [String(zed.id), '9999'],
      },
    ],
  },
  'PUT /api/vendors/:accountId/rates': {
    kind: 'object',
    pairs: () => [
      {
        actual: { method: 'PUT', url: `/api/vendors/${zed.id}/rates`, body: {} },
        missing: { method: 'PUT', url: '/api/vendors/9999/rates', body: {} },
        echo: [String(zed.id), '9999'],
      },
    ],
  },
  'GET /api/assignments/:id': assignmentEntry('GET', ''),
  'GET /api/assignments/:id/offer': assignmentEntry('GET', '/offer'),
  ...Object.fromEntries(
    assignmentVerbs.map((verb) => [
      `POST /api/assignments/:id/${verb}`,
      assignmentEntry('POST', `/${verb}`),
    ]),
  ),

  // A client number is the tenant's own: the same number is two clients, so A reads a client
  // nobody has configured, never B's consent.
  'GET /api/clients/:clientId/engine': {
    kind: 'object',
    pairs: (w) => [
      {
        actual: { method: 'GET', url: `/api/clients/${w.clientId}/engine` },
        missing: { method: 'GET', url: '/api/clients/8/engine' },
        echo: [String(w.clientId), '8'],
        status: 200,
      },
    ],
  },
  'PUT /api/clients/:clientId/engine': {
    kind: 'own',
    why: 'a number the caller typed, in the caller’s tenant',
    req: {
      method: 'PUT',
      url: '/api/clients/7/engine',
      body: { consent: { deepl: true } },
    },
  },
  'PUT /api/client-pools/:clientId': {
    kind: 'own',
    why: 'a number the caller typed, in the caller’s roster',
    req: { method: 'PUT', url: '/api/client-pools/7', body: { vendors: [] } },
  },
};

const offer = (project: string) => ({
  project,
  channel: 'direct',
  vendors: [1],
  deadline: '2026-03-10T17:00:00Z',
  instructions: 'x',
});

function jobEntry(method: 'GET' | 'DELETE'): Entry {
  return {
    kind: 'object',
    pairs: (w) => [
      {
        actual: { method, url: `/api/jobs/${w.jobId}` },
        missing: { method, url: '/api/jobs/not-a-job' },
        echo: [w.jobId, 'not-a-job'],
      },
    ],
  };
}

function assignmentEntry(method: 'GET' | 'POST', suffix: string): Entry {
  return {
    kind: 'object',
    pairs: (w) => {
      const body = method === 'POST' ? { body: { paidOn: '2026-03-12' } } : {};
      const pair = (query: (u: string) => string): Pair => ({
        actual: {
          method,
          url: query(`/api/assignments/${w.assignmentId}${suffix}`),
          ...body,
        },
        missing: { method, url: query(`/api/assignments/9999${suffix}`), ...body },
        echo: [String(w.assignmentId), '9999'],
      });
      // by the caller's own roster, and by naming B's tenant as a stranger to it
      return [pair((u) => u), pair(asTenantB)];
    },
  };
}

// --- project routes: probed without an entry ---------------------------

const PROJECT_ROUTE = /^[A-Z]+ \/api\/projects\/:name(\/|$)/;

const PARAMS: Record<string, (w: World) => string> = {
  ':fileId': (w) => String(w.fileId),
  ':segmentId': (w) => String(w.segmentId),
  ':id': () => '1',
  ':refId': () => '1',
  ':rule': () => 'tag.missing',
};

/** A project route's request for the project `name`, with every other parameter filled. */
function projectRequest(route: string, name: string, w: World): Req {
  const [method, pattern] = route.split(' ') as [Req['method'], string];
  let url = pattern.replace(':name', name);
  for (const [param, value] of Object.entries(PARAMS)) url = url.replace(param, value(w));
  // `{}` for every write: nothing here may depend on the body being good, because the
  // control (a missing project) must be a 404 for the probe to count.
  return method === 'GET' || method === 'DELETE'
    ? { method, url }
    : { method, url, body: {} };
}

const normalise = (res: Res, from: string, to: string): Res => ({
  status: res.status,
  body: res.body.split(from).join(to),
});

// --- the tests ---------------------------------------------------------

/** Fastify adds a HEAD for every GET and answers OPTIONS itself: neither is a route of ours. */
const registeredRoutes = (): string[] =>
  routes.filter((r) => !r.startsWith('HEAD ') && !r.startsWith('OPTIONS '));

describe('the matrix covers every route the app registers', () => {
  it('every route is classified, and no entry names a route that is gone', () => {
    const registered = registeredRoutes();
    const known = new Set(Object.keys(ROUTES));
    const unclassified = registered.filter(
      (r) => !known.has(r) && !PROJECT_ROUTE.test(r),
    );
    expect(unclassified, 'add each of these to ROUTES (isolation.test.ts)').toEqual([]);
    const stale = [...known].filter((k) => !registered.includes(k));
    expect(stale, 'these ROUTES entries name no registered route').toEqual([]);
    const shadowed = [...known].filter((k) => PROJECT_ROUTE.test(k));
    expect(shadowed, 'project routes are probed without an entry').toEqual([]);
  });
});

describe('a session of tenant A, against tenant B', () => {
  it('gets what a missing object gets, on every route', async () => {
    const a = await login('alice');
    const c = await login('carol');
    const before = await viewOf(c);
    const failures: string[] = [];
    let probes = 0;

    const compare = async (
      label: string,
      actual: Req,
      missing: Req,
      echo: readonly [string, string],
      expected = 404,
    ) => {
      const got = await send(a, actual);
      const want = normalise(await send(a, missing), echo[1], echo[0]);
      probes++;
      if (want.status !== expected) {
        failures.push(
          `${label}: the control is ${want.status}, not ${expected} (${want.body.slice(0, 120)}): give the probe a body that gets past validation`,
        );
      } else if (got.status !== want.status || got.body !== want.body) {
        failures.push(
          `${label}: B's object answered ${got.status} ${got.body.slice(0, 160)}; a missing one answers ${want.status} ${want.body.slice(0, 160)}`,
        );
      }
    };

    for (const route of registeredRoutes().filter((r) => PROJECT_ROUTE.test(r))) {
      for (const query of [(u: string) => u, asTenantB]) {
        const actual = projectRequest(route, world.project, world);
        const missing = projectRequest(route, 'b-ghost', world);
        await compare(
          `${route}${query === asTenantB ? ' ?tenant=B' : ''}`,
          { ...actual, url: query(actual.url) },
          { ...missing, url: query(missing.url) },
          [world.project, 'b-ghost'],
        );
      }
    }

    for (const [route, entry] of Object.entries(ROUTES)) {
      if (entry.kind === 'object') {
        for (const pair of entry.pairs(world)) {
          await compare(
            route,
            pair.actual,
            pair.missing,
            pair.echo ?? ['', ''],
            pair.status,
          );
        }
      } else if (entry.kind === 'list') {
        const [method, url] = route.split(' ') as [Req['method'], string];
        const query = url === '/api/vendors/eligibility' ? `${url}?src=en&tgt=de` : url;
        const res = await send(a, { method, url: query });
        probes++;
        const shown = world.markers.filter((m) => res.body.includes(m));
        if (shown.length > 0) failures.push(`${route} shows B's ${shown.join(', ')}`);
      }
    }

    // Last, because they make things in A's own tenant, and an id or a name A holds is
    // not B's to be mistaken for: every probe above ran against an A with nothing in it.
    for (const entry of Object.values(ROUTES)) {
      if (entry.kind === 'own' && entry.req) {
        await send(a, entry.req);
        probes++;
      }
    }

    expect(failures).toEqual([]);
    expect(probes).toBeGreaterThan(120);
    // writes that answered 404 and happened anyway would show here
    expect(await viewOf(c)).toEqual(before);
  });

  it('is told the same of a client number that only B configured', async () => {
    const a = await login('alice');
    const mine = await send(a, {
      method: 'GET',
      url: `/api/clients/${world.clientId}/engine`,
    });
    expect(mine.status).toBe(200);
    expect(mine.body).not.toContain('true');
  });
});

/** Tenant B's own view of what it holds: whatever A's probes did, this is what B reads. */
async function viewOf(token: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const url of [
    '/api/projects',
    '/api/tms',
    '/api/glossaries',
    '/api/jobs',
    '/api/invitations',
    '/api/staff',
    '/api/webhooks',
    '/api/vendors',
    '/api/assignments',
    '/api/projects/b-job',
    `/api/projects/b-job/files/${world.fileId}/segments`,
    `/api/clients/${world.clientId}/engine`,
  ]) {
    out[url] = (await send(token, { method: 'GET', url })).body;
  }
  return out;
}
