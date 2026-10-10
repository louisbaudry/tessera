/** The webhook endpoints and their outbox (backlog #125; vendor-spec.md, its #125 note). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InvalidAssignmentTransitionError } from '@cat-tool/vendor-core';
import {
  MAX_PENDING_WEBHOOKS,
  MAX_WEBHOOK_ENDPOINTS,
  WEBHOOK_RETRY_DELAYS_MS,
} from '@cat-tool/vendor-core/webhook';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import { listEvents } from '../audit/events.js';
import {
  acceptAssignment,
  addVendor,
  addWebhookEndpoint,
  createDirectOffer,
  createVendorFile,
  deleteWebhookEndpoint,
  deliverAssignment,
  dueWebhooks,
  enqueueWebhookPing,
  listWebhookEndpoints,
  moveAssignment,
  nextWebhookDue,
  postToPool,
  pruneWebhooks,
  setVendorRate,
  settleWebhook,
  startAssignment,
} from './index.js';

const NOW = new Date('2026-03-01T10:00:00Z');
const owner = { ...TEST_ACTOR, label: 'owner' };
const who = { ...TEST_ACTOR, label: 'vendor' };
const URL1 = 'https://hooks.example.com/in/secret-token?x=1';

let dir: string;
let db: Database;
let ana: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-webhooks-'));
  db = createVendorFile(join(dir, 'vendors.ctv'), { generator: 'test' });
  ana = addVendor(db, { accountId: 10, actor: TEST_ACTOR }).id;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const endpoint = (url = URL1) => addWebhookEndpoint(db, { url, actor: owner, now: NOW });
const rows = () =>
  db
    .prepare(
      'SELECT id, event_type AS type, body, status, attempts FROM webhook_delivery ORDER BY rowid',
    )
    .all() as Array<{
    id: string;
    type: string;
    body: string;
    status: string;
    attempts: number;
  }>;

describe('registering an endpoint', () => {
  it('returns the secret once and never lists it, nor the path or query', () => {
    const made = endpoint();
    expect(made.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(made.host).toBe('hooks.example.com');
    const listed = listWebhookEndpoints(db);
    expect(listed).toEqual([
      expect.objectContaining({ id: made.id, host: 'hooks.example.com', pending: 0 }),
    ]);
    const json = JSON.stringify(listed);
    expect(json).not.toContain(made.secret);
    expect(json).not.toContain('secret-token');
  });

  it('logs the host alone, with the session as actor, and never the secret or the token', () => {
    const made = endpoint();
    const events = listEvents(db, { subjectType: 'webhook_endpoint' }).filter(
      (e) => e.action === 'webhook.created',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ subjectId: String(made.id) });
    const text = JSON.stringify(events[0]);
    expect(text).toContain('hooks.example.com');
    expect(text).not.toContain(made.secret);
    expect(text).not.toContain('secret-token');
  });

  it('refuses a URL the server would not call, and a fourth endpoint', () => {
    for (const bad of [
      'http://hooks.example.com/',
      'https://127.0.0.1/',
      'https://hooks.example.com:8443/',
      'https://user:pw@hooks.example.com/',
      'not a url',
    ]) {
      expect(() => endpoint(bad), bad).toThrow();
    }
    for (let i = 0; i < MAX_WEBHOOK_ENDPOINTS; i++)
      endpoint(`https://h${i}.example.com/`);
    expect(() => endpoint('https://h9.example.com/')).toThrow(/at most/);
  });

  it('is removed with its queue, logged, and a second removal says there was none', () => {
    const made = endpoint();
    enqueueWebhookPing(db, made.id, NOW);
    expect(rows()).toHaveLength(1);
    expect(deleteWebhookEndpoint(db, { id: made.id, actor: owner })).toBe(true);
    expect(rows()).toHaveLength(0);
    expect(listWebhookEndpoints(db)).toEqual([]);
    expect(
      listEvents(db, { subjectType: 'webhook_endpoint' }).some(
        (e) => e.action === 'webhook.deleted',
      ),
    ).toBe(true);
    expect(deleteWebhookEndpoint(db, { id: made.id, actor: owner })).toBe(false);
  });
});

describe('the outbox', () => {
  it('queues nothing while no endpoint is registered', () => {
    createDirectOffer(db, { projectName: 'p', vendorId: ana, actor: owner, now: NOW });
    expect(rows()).toHaveLength(0);
  });

  it('writes one row per endpoint for every assignment event, with ids and states only', () => {
    endpoint();
    endpoint('https://other.example.com/hook');
    const a = createDirectOffer(db, {
      projectName: 'client-acme-brochure',
      vendorId: ana,
      instructions: 'Keep it formal for the Acme account.',
      actor: owner,
      now: NOW,
    });
    acceptAssignment(db, { assignmentId: a.id, vendorId: ana, actor: who, now: NOW });
    const sent = rows();
    expect(sent.map((r) => r.type)).toEqual([
      'assignment.offered',
      'assignment.offered',
      'assignment.accepted',
      'assignment.accepted',
    ]);
    const accepted = JSON.parse(sent[2]!.body);
    expect(accepted).toEqual({
      id: sent[2]!.id,
      type: 'assignment.accepted',
      createdAt: NOW.toISOString(),
      assignmentId: a.id,
      from: 'offered',
      to: 'accepted',
      vendorAccountId: 10,
    });
    // nothing a person typed is in what is sent
    for (const r of sent) {
      expect(r.body).not.toMatch(/acme|formal|brochure/i);
    }
  });

  it('reports a pool post with no vendor account yet', () => {
    endpoint();
    postToPool(db, { projectName: 'p', vendorIds: [ana], actor: owner, now: NOW });
    expect(JSON.parse(rows()[0]!.body)).toMatchObject({
      type: 'assignment.pool_open',
      vendorAccountId: null,
    });
  });

  it('is written in the transaction of the event: a refused move leaves no row behind', () => {
    endpoint();
    const a = createDirectOffer(db, {
      projectName: 'p',
      vendorId: ana,
      actor: owner,
      now: NOW,
    });
    const before = rows().length;
    expect(() =>
      deliverAssignment(db, {
        assignmentId: a.id,
        vendorId: ana,
        pair: null,
        actor: who,
        now: NOW,
      }),
    ).toThrow(InvalidAssignmentTransitionError); // an offer cannot be delivered
    expect(rows()).toHaveLength(before);
    const events = (
      db.prepare('SELECT COUNT(*) AS n FROM assignment_event').get() as { n: number }
    ).n;
    expect(rows()).toHaveLength(events); // one endpoint: one row per event, always
  });

  it('adds payable.locked beside the delivery that locked it, and not when nothing was priced', () => {
    endpoint();
    setVendorRate(db, {
      vendorId: ana,
      pair: { src: 'en', tgt: 'de' },
      tier: 'no_match',
      rateMicros: 80_000,
      currency: 'EUR',
      effectiveFrom: '2026-03-01',
      actor: owner,
      now: NOW,
    });
    const a = createDirectOffer(db, {
      projectName: 'p',
      vendorId: ana,
      analysis: { no_match: 100 },
      actor: owner,
      now: NOW,
    });
    acceptAssignment(db, { assignmentId: a.id, vendorId: ana, actor: who, now: NOW });
    startAssignment(db, { assignmentId: a.id, vendorId: ana, actor: who, now: NOW });
    deliverAssignment(db, {
      assignmentId: a.id,
      vendorId: ana,
      pair: { src: 'en', tgt: 'de' },
      actor: who,
      now: NOW,
    });
    const types = rows().map((r) => r.type);
    expect(types.slice(-2)).toEqual(['assignment.delivered', 'payable.locked']);
    const locked = JSON.parse(rows().at(-1)!.body);
    expect(locked).toMatchObject({ assignmentId: a.id, from: null, to: null });
    expect(JSON.stringify(locked)).not.toMatch(/EUR|8000|amount|total/i);

    // a job with no analysis delivers without a payable, and so reports none
    const b = createDirectOffer(db, {
      projectName: 'q',
      vendorId: ana,
      actor: owner,
      now: NOW,
    });
    for (const to of ['accepted', 'in_progress', 'delivered'] as const) {
      moveAssignment(db, {
        assignmentId: b.id,
        vendorId: ana,
        to,
        by: 'vendor',
        actor: who,
        now: NOW,
      });
    }
    expect(rows().filter((r) => r.type === 'payable.locked')).toHaveLength(1);
  });

  it('refuses new rows for an endpoint whose queue is full instead of growing', () => {
    const made = endpoint();
    for (let i = 0; i < MAX_PENDING_WEBHOOKS; i++) enqueueWebhookPing(db, made.id, NOW);
    enqueueWebhookPing(db, made.id, NOW);
    const all = rows();
    expect(all.filter((r) => r.status === 'pending')).toHaveLength(MAX_PENDING_WEBHOOKS);
    expect(all.at(-1)).toMatchObject({ status: 'failed' });
    expect(listWebhookEndpoints(db)[0]).toMatchObject({
      pending: MAX_PENDING_WEBHOOKS,
      failed: 1,
    });
  });

  it('answers a test for an endpoint that is not there with false', () => {
    expect(enqueueWebhookPing(db, 99, NOW)).toBe(false);
  });
});

describe('attempts', () => {
  it('delivers on a 2xx and leaves it settled', () => {
    const made = endpoint();
    enqueueWebhookPing(db, made.id, NOW);
    const [due] = dueWebhooks(db, NOW);
    expect(due).toMatchObject({
      endpointId: made.id,
      url: expect.stringContaining('hooks.example.com'),
    });
    expect(due!.secret).toBe(made.secret);
    expect(
      settleWebhook(db, due!.id, { ok: true, httpStatus: 204, error: null }, NOW),
    ).toBe('delivered');
    expect(dueWebhooks(db, new Date(NOW.getTime() + 1e10))).toEqual([]);
    expect(listWebhookEndpoints(db)[0]).toMatchObject({
      delivered: 1,
      pending: 0,
      lastStatus: 204,
    });
    // a settled delivery cannot be settled again
    expect(() =>
      settleWebhook(db, due!.id, { ok: true, httpStatus: 200, error: null }, NOW),
    ).toThrow();
  });

  it('retries on the schedule and gives up after the sixth failure', () => {
    const made = endpoint();
    enqueueWebhookPing(db, made.id, NOW);
    const id = dueWebhooks(db, NOW)[0]!.id;
    let clock = NOW.getTime();
    for (let attempt = 1; attempt <= 5; attempt++) {
      const state = settleWebhook(
        db,
        id,
        { ok: false, httpStatus: 503, error: 'http' },
        new Date(clock),
      );
      expect(state).toBe('pending');
      const delay = WEBHOOK_RETRY_DELAYS_MS[attempt - 1]!;
      // not due a moment early, due at the delay
      expect(dueWebhooks(db, new Date(clock + delay - 1))).toEqual([]);
      clock += delay;
      expect(dueWebhooks(db, new Date(clock))).toHaveLength(1);
    }
    expect(
      settleWebhook(
        db,
        id,
        { ok: false, httpStatus: null, error: 'timeout' },
        new Date(clock),
      ),
    ).toBe('failed');
    expect(rows()[0]).toMatchObject({ status: 'failed', attempts: 6 });
    expect(dueWebhooks(db, new Date(clock + 1e11))).toEqual([]);
    expect(nextWebhookDue(db)).toBeNull();
  });

  it('tells when the next one is due', () => {
    const made = endpoint();
    expect(nextWebhookDue(db)).toBeNull();
    enqueueWebhookPing(db, made.id, NOW);
    expect(nextWebhookDue(db)).toBe(NOW.toISOString());
  });

  it('prunes delivered rows after 14 days and failed ones after 30', () => {
    const made = endpoint();
    for (let i = 0; i < 2; i++) enqueueWebhookPing(db, made.id, NOW);
    const [d, f] = dueWebhooks(db, NOW);
    settleWebhook(db, d!.id, { ok: true, httpStatus: 200, error: null }, NOW);
    db.prepare(`UPDATE webhook_delivery SET attempts = 5 WHERE id = ?`).run(f!.id);
    settleWebhook(db, f!.id, { ok: false, httpStatus: 500, error: 'http' }, NOW);
    const day = 86_400_000;
    expect(pruneWebhooks(db, new Date(NOW.getTime() + 13 * day))).toBe(0);
    expect(pruneWebhooks(db, new Date(NOW.getTime() + 15 * day))).toBe(1); // the delivered one
    expect(pruneWebhooks(db, new Date(NOW.getTime() + 29 * day))).toBe(0);
    expect(pruneWebhooks(db, new Date(NOW.getTime() + 31 * day))).toBe(1); // the failed one
    expect(rows()).toHaveLength(0);
  });
});
