/**
 * `portal.sqlite`'s audit trail (audit-spec.md §2.6, §6; backlog #58):
 * `order_event` carries its actor and cannot be rewritten, and the
 * shared `audit_event` records what `order_event` does not.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PORTAL_AUDIT_ACTIONS, type AuditActor } from '@cat-tool/core';
import { hashPassword, OrderPricingError } from '@cat-tool/portal-core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import {
  appendAuditEvent,
  auditEventDdl,
  listEvents,
  verifyAudit,
} from '../audit/events.js';
import { openAndMigrate } from '../migrate.js';
import {
  createAdminSession,
  createAdminUser,
  createClient,
  createOrder,
  insertDeliveredFile,
  insertSourceFile,
  listOrderEvents,
  openPortalDb,
  recordFailedAdminLogin,
  recordFileDownload,
  setStatus,
  setWordCountAndPrice,
} from './index.js';
import { PORTAL_APPLICATION_ID, PORTAL_MIGRATIONS } from './schema.js';

const ADMIN: AuditActor = { actor: { kind: 'admin', id: 1 }, label: 'admin@example.com' };
const CLIENT: AuditActor = { actor: { kind: 'client', id: 1 }, label: null };
const GATE: AuditActor = { actor: { kind: 'system', name: 'login' }, label: null };

const FILE = {
  filename: 'brochure.docx',
  contentType: 'application/octet-stream',
  byteSize: 3,
  storagePath: 'orders/1/x',
};

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-portal-audit-'));
  db = openPortalDb(join(dir, 'portal.sqlite'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const newOrder = () => {
  const client = createClient(db, 'Ada', 'ada@example.com', 'tok');
  return createOrder(
    db,
    { clientId: client.id, srcLang: 'en', tgtLangs: ['fr'] },
    { actor: CLIENT },
  );
};

const allEvents = () =>
  db
    .prepare(
      'SELECT actor, actor_label, action, subject_type, subject_id, detail FROM audit_event ORDER BY id',
    )
    .all();

describe('order_event', () => {
  it('records the actor of every transition', () => {
    const order = newOrder();
    setWordCountAndPrice(db, order.id, 1000, 120, { actor: ADMIN });
    setStatus(db, order.id, 'approved', { actor: CLIENT, note: 'approved by client' });
    setStatus(db, order.id, 'in_progress', { actor: ADMIN });
    expect(
      listOrderEvents(db, order.id).map((e) => [e.toStatus, e.actor, e.actorLabel]),
    ).toEqual([
      ['submitted', 'client:1', null],
      ['approved', 'client:1', null],
      ['in_progress', 'admin:1', 'admin@example.com'],
    ]);
  });

  it('aborts an UPDATE and a DELETE, and lets only a label erasure through', () => {
    const order = newOrder();
    setWordCountAndPrice(db, order.id, 1000, 120, { actor: ADMIN });
    setStatus(db, order.id, 'approved', { actor: ADMIN });
    expect(() =>
      db.prepare("UPDATE order_event SET to_status = 'cancelled'").run(),
    ).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE order_event SET actor = 'admin:2'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare("UPDATE order_event SET actor_label = 'x'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM order_event').run()).toThrow(/append-only/);

    // Erasure (spec §5): the admin's email goes, who acted stays.
    db.prepare(
      "UPDATE order_event SET actor_label = '[erased]' WHERE actor = 'admin:1'",
    ).run();
    expect(listOrderEvents(db, order.id).map((e) => [e.actor, e.actorLabel])).toEqual([
      ['client:1', null],
      ['admin:1', '[erased]'],
    ]);
  });

  it('attributes rows older than the column to system:migration, and invents no author', () => {
    db.close();
    const path = join(dir, 'old.sqlite');
    const old = openAndMigrate(path, {
      applicationId: PORTAL_APPLICATION_ID,
      migrations: PORTAL_MIGRATIONS.slice(0, 2),
    });
    old.exec(`
      INSERT INTO client (id, name, email, access_token, created_at)
        VALUES (1, 'Ada', 'ada@example.com', 'tok', '2026-01-01');
      INSERT INTO translation_order
        (id, client_id, src_lang, notes, status, word_count, price, created_at, updated_at)
        VALUES (1, 1, 'en', NULL, 'approved', NULL, NULL, '2026-01-01', '2026-01-02');
      INSERT INTO order_event (id, order_id, from_status, to_status, note, created_at)
        VALUES (1, 1, NULL, 'submitted', 'order created', '2026-01-01'),
               (2, 1, 'submitted', 'approved', NULL, '2026-01-02');
    `);
    old.close();

    db = openPortalDb(path);
    expect(db.pragma('user_version', { simple: true })).toBe(PORTAL_MIGRATIONS.length);
    expect(listOrderEvents(db, 1)).toEqual([
      {
        id: 1,
        orderId: 1,
        fromStatus: null,
        toStatus: 'submitted',
        note: 'order created',
        createdAt: '2026-01-01',
        actor: 'system:migration',
        actorLabel: null,
      },
      {
        id: 2,
        orderId: 1,
        fromStatus: 'submitted',
        toStatus: 'approved',
        note: null,
        createdAt: '2026-01-02',
        actor: 'system:migration',
        actorLabel: null,
      },
    ]);
    expect(() => db.prepare('DELETE FROM order_event').run()).toThrow(/append-only/);
    // A transition is order_event's alone (spec decision 7): no audit_event baseline.
    expect(allEvents()).toEqual([]);
  });
});

describe('portal audit_event', () => {
  it('admits only portal actions', () => {
    expect(() =>
      appendAuditEvent(db, {
        actor: TEST_ACTOR,
        action: 'project.created',
        subjectType: 'project',
        subjectId: '1/x',
        detail: null,
      }),
    ).toThrow(/CHECK/);
  });

  it('records an admin login in the session transaction, and a refused one as the gate', () => {
    const admin = createAdminUser(db, 'admin@example.com', hashPassword('pw'));
    createAdminSession(db, admin.id, 'token', { actor: ADMIN });
    recordFailedAdminLogin(db, {
      actor: GATE,
      adminUserId: admin.id,
      reason: 'wrong_password',
    });
    recordFailedAdminLogin(db, {
      actor: GATE,
      adminUserId: null,
      reason: 'unknown_email',
    });
    expect(allEvents()).toEqual([
      {
        actor: 'admin:1',
        actor_label: 'admin@example.com',
        action: 'auth.login',
        subject_type: 'admin_user',
        subject_id: '1',
        detail: null,
      },
      {
        actor: 'system:login',
        actor_label: null,
        action: 'auth.login_failed',
        subject_type: 'admin_user',
        subject_id: '1',
        detail: '{"reason":"wrong_password"}',
      },
      {
        actor: 'system:login',
        actor_label: null,
        action: 'auth.login_failed',
        subject_type: 'admin_user',
        subject_id: null,
        detail: '{"reason":"unknown_email"}',
      },
    ]);
    expect(verifyAudit(db)).toEqual({ events: 3, brokenAt: null });
  });

  it('records a delivery with its row, and a download of either kind of file', () => {
    const order = newOrder();
    const source = insertSourceFile(db, { ...FILE, orderId: order.id, wordCount: null });
    const delivered = insertDeliveredFile(
      db,
      { ...FILE, orderId: order.id, filename: 'brochure.fr.docx' },
      { actor: ADMIN, sha256: 'a'.repeat(64) },
    );
    recordFileDownload(db, {
      actor: ADMIN,
      kind: 'source',
      file: source,
      sha256: 'b'.repeat(64),
    });
    recordFileDownload(db, {
      actor: CLIENT,
      kind: 'delivered',
      file: delivered,
      sha256: 'a'.repeat(64),
    });

    expect(
      listEvents(db, {
        subjectType: 'delivered_file',
        subjectId: String(delivered.id),
      }).map((e) => [e.action, e.actor, e.detail]),
    ).toEqual([
      [
        'file.delivered',
        'admin:1',
        JSON.stringify({
          order_id: order.id,
          name: 'brochure.fr.docx',
          sha256: 'a'.repeat(64),
        }),
      ],
      [
        'file.downloaded',
        'client:1',
        JSON.stringify({
          file_id: delivered.id,
          name: 'brochure.fr.docx',
          sha256: 'a'.repeat(64),
        }),
      ],
    ]);
    // Same row id in the other table: a different subject, never confused.
    expect(
      listEvents(db, { subjectType: 'source_file', subjectId: String(source.id) }).map(
        (e) => [e.action, e.actor],
      ),
    ).toEqual([['file.downloaded', 'admin:1']]);
    expect(verifyAudit(db)).toEqual({ events: 3, brokenAt: null });
  });

  it('stores no delivered_file row when its event cannot be written', () => {
    const order = newOrder();
    expect(() =>
      insertDeliveredFile(
        db,
        { ...FILE, orderId: order.id },
        { actor: { actor: { kind: 'admin', id: 0 }, label: null }, sha256: 'a' },
      ),
    ).toThrow(/malformed actor/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM delivered_file').get()).toEqual({
      n: 0,
    });
  });
});

describe('pricing (backlog #63)', () => {
  const pricedEvents = (orderId: number) =>
    listEvents(db, { subjectType: 'translation_order', subjectId: String(orderId) }).map(
      (e) => [e.action, e.actor, e.actorLabel, e.detail],
    );

  it('records one order.priced naming the admin, and nothing for a repeat', () => {
    const order = newOrder();
    setWordCountAndPrice(db, order.id, 1000, 120, { actor: ADMIN });
    setWordCountAndPrice(db, order.id, 1000, 120, { actor: ADMIN });
    expect(pricedEvents(order.id)).toEqual([
      [
        'order.priced',
        'admin:1',
        'admin@example.com',
        JSON.stringify({ word_count: 1000, price: 120 }),
      ],
    ]);
    // A real change while still submitted is a second event.
    setWordCountAndPrice(db, order.id, 1200, 144, { actor: ADMIN });
    expect(pricedEvents(order.id)).toHaveLength(2);
    expect(verifyAudit(db)).toEqual({ events: 2, brokenAt: null });
  });

  it('refuses to re-price an approved order, and writes nothing', () => {
    const order = newOrder();
    setWordCountAndPrice(db, order.id, 1000, 120, { actor: ADMIN });
    setStatus(db, order.id, 'approved', { actor: CLIENT, seenPrice: 120 });
    expect(() => setWordCountAndPrice(db, order.id, 2000, 240, { actor: ADMIN })).toThrow(
      OrderPricingError,
    );
    expect(db.prepare('SELECT word_count, price FROM translation_order').get()).toEqual({
      word_count: 1000,
      price: 120,
    });
    expect(pricedEvents(order.id)).toHaveLength(1);
  });

  it('prices an order approved without a price once, then refuses', () => {
    // Only reachable before #63, through the admin PATCH: built directly.
    const order = newOrder();
    db.prepare("UPDATE translation_order SET status = 'approved' WHERE id = ?").run(
      order.id,
    );
    setWordCountAndPrice(db, order.id, 1000, 120, { actor: ADMIN });
    expect(() => setWordCountAndPrice(db, order.id, 1100, 132, { actor: ADMIN })).toThrow(
      /re-price/,
    );
    expect(pricedEvents(order.id)).toHaveLength(1);
  });

  it('refuses to approve an unpriced order, or a price other than the one seen', () => {
    const order = newOrder();
    expect(() => setStatus(db, order.id, 'approved', { actor: ADMIN })).toThrow(
      OrderPricingError,
    );
    setWordCountAndPrice(db, order.id, 1000, 120, { actor: ADMIN });
    expect(() =>
      setStatus(db, order.id, 'approved', { actor: CLIENT, seenPrice: 100 }),
    ).toThrow(/reload/);
    expect(listOrderEvents(db, order.id).map((e) => e.toStatus)).toEqual(['submitted']);
    setStatus(db, order.id, 'approved', { actor: CLIENT, seenPrice: 120 });
    expect(listOrderEvents(db, order.id).map((e) => e.toStatus)).toEqual([
      'submitted',
      'approved',
    ]);
  });
});

describe('portal v4: audit_event widened, prices baselined (backlog #63)', () => {
  const V3_INSERT_PRICED = `
    INSERT INTO audit_event (at, actor, action, subject_type, subject_id, chain_hash)
      VALUES ('t', 'admin:1', 'order.priced', 'translation_order', '1', 'h')`;

  it('keeps every row, id and the chain, admits order.priced, and baselines prices', () => {
    db.close();
    const path = join(dir, 'v3.sqlite');
    const old = openAndMigrate(path, {
      applicationId: PORTAL_APPLICATION_ID,
      migrations: PORTAL_MIGRATIONS.slice(0, 3),
    });
    old.exec(`
      INSERT INTO client (id, name, email, access_token, created_at)
        VALUES (1, 'Ada', 'ada@example.com', 'tok', '2026-01-01');
      INSERT INTO translation_order
        (id, client_id, src_lang, notes, status, word_count, price, created_at, updated_at)
        VALUES (1, 1, 'en', NULL, 'approved', 1000, 120, '2026-01-01', '2026-01-02'),
               (2, 1, 'en', NULL, 'submitted', NULL, NULL, '2026-01-03', '2026-01-03');
    `);
    const admin = createAdminUser(old, 'admin@example.com', hashPassword('pw'));
    createAdminSession(old, admin.id, 'token', { actor: ADMIN });
    recordFailedAdminLogin(old, {
      actor: GATE,
      adminUserId: null,
      reason: 'unknown_email',
    });
    expect(() => old.prepare(V3_INSERT_PRICED).run()).toThrow(/CHECK constraint failed/);
    const before = old.prepare('SELECT * FROM audit_event ORDER BY id').all();
    old.close();

    db = openPortalDb(path);
    expect(db.pragma('user_version', { simple: true })).toBe(PORTAL_MIGRATIONS.length);
    const rows = db.prepare('SELECT * FROM audit_event ORDER BY id').all();
    expect(rows.slice(0, before.length)).toEqual(before);
    // One baseline, for the one priced order, and no author invented.
    expect(pricedEventsFor(db, 1)).toEqual([
      [
        'order.price_baseline',
        'system:migration',
        null,
        JSON.stringify({ word_count: 1000, price: 120 }),
      ],
    ]);
    expect(pricedEventsFor(db, 2)).toEqual([]);
    expect(verifyAudit(db)).toEqual({ events: 3, brokenAt: null });

    setWordCountAndPrice(db, 2, 500, 60, { actor: ADMIN });
    expect(pricedEventsFor(db, 2).map((e) => e[0])).toEqual(['order.priced']);
    expect(verifyAudit(db).brokenAt).toBeNull();

    // The rebuilt table is exactly a fresh one: table, indexes and triggers.
    const blank = new Database(':memory:');
    blank.exec(auditEventDdl(PORTAL_AUDIT_ACTIONS));
    expect(auditSchema(db)).toEqual(auditSchema(blank));
    blank.close();
  });

  const pricedEventsFor = (target: Database.Database, orderId: number) =>
    listEvents(target, {
      subjectType: 'translation_order',
      subjectId: String(orderId),
    }).map((e) => [e.action, e.actor, e.actorLabel, e.detail]);

  const auditSchema = (target: Database.Database) =>
    target
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE tbl_name = 'audit_event' ORDER BY type, name`,
      )
      .all();
});
