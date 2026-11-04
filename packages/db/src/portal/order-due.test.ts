/**
 * The translator's own due date on an order (issue #179, `planning/solo-translator-spec.md` D4):
 * set and cleared by the admin, logged as `order.due_set` in the same transaction, a calendar day
 * and nothing else, and invisible to the order's client-facing timestamp.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ACTOR } from '../audit/actor.fixture.js';
import {
  createClient,
  createOrder,
  getOrder,
  openPortalDb,
  setOrderDue,
} from './index.js';

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cat-portal-order-due-'));
  db = openPortalDb(join(dir, 'portal.sqlite'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const dueEvents = () =>
  (
    db
      .prepare(
        "SELECT detail FROM audit_event WHERE action = 'order.due_set' ORDER BY id",
      )
      .all() as Array<{ detail: string }>
  ).map((r) => JSON.parse(r.detail) as unknown);

function anOrder() {
  const client = createClient(db, 'Client A', 'a@client.example', 'tok-a');
  return createOrder(
    db,
    { clientId: client.id, srcLang: 'en', tgtLangs: ['de'] },
    {
      actor: TEST_ACTOR,
    },
  );
}

describe('setOrderDue', () => {
  it('sets and clears a due date, logging each change and nothing for a repeat', () => {
    const order = anOrder();
    expect(order.dueAt).toBeNull();
    expect(setOrderDue(db, order.id, '2026-11-20', { actor: TEST_ACTOR }).dueAt).toBe(
      '2026-11-20',
    );
    setOrderDue(db, order.id, '2026-11-20', { actor: TEST_ACTOR });
    expect(setOrderDue(db, order.id, null, { actor: TEST_ACTOR }).dueAt).toBeNull();
    expect(dueEvents()).toEqual([{ due_at: '2026-11-20' }, { due_at: null }]);
  });

  it('leaves the order’s updated_at alone, which the client reads', () => {
    const order = anOrder();
    setOrderDue(db, order.id, '2026-11-20', { actor: TEST_ACTOR });
    expect(getOrder(db, order.id)!.updatedAt).toBe(order.updatedAt);
  });

  it('refuses anything but a calendar day, and the schema refuses it too', () => {
    const order = anOrder();
    expect(() =>
      setOrderDue(db, order.id, '2026-11-20T10:00:00Z', { actor: TEST_ACTOR }),
    ).toThrow(RangeError);
    expect(() =>
      db
        .prepare('UPDATE translation_order SET due_at = ? WHERE id = ?')
        .run('soon', order.id),
    ).toThrow(/CHECK/);
    expect(dueEvents()).toEqual([]);
  });

  it('throws for a missing order', () => {
    expect(() => setOrderDue(db, 999, '2026-11-20', { actor: TEST_ACTOR })).toThrow(
      /not found/,
    );
  });
});
