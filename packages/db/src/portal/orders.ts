/**
 * `translation_order` repository (portal-v0-spec.md §2, §6).
 *
 * `setStatus` is the one place an order's status column changes — it
 * always writes the matching `order_event` row in the same transaction,
 * so status history can never drift from the current status, and it
 * always checks `assertValidTransition` first, so an illegal transition
 * can't reach the database from any caller.
 *
 * Every `order_event` names its actor (audit-spec.md §2.6; backlog #58),
 * a required parameter on both writers: `admin:<id>` for an admin's
 * session, `client:<id>` for whoever holds a client's private link.
 * Transitions are recorded here and nowhere else (spec decision 7).
 */

import { formatActor, type AuditActor } from '@cat-tool/core';
import { assertValidTransition, type OrderStatus } from '@cat-tool/portal-core';
import type Database from 'better-sqlite3';

export interface TranslationOrder {
  readonly id: number;
  readonly clientId: number;
  readonly srcLang: string;
  readonly tgtLangs: readonly string[];
  readonly notes: string | null;
  readonly status: OrderStatus;
  readonly wordCount: number | null;
  readonly price: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OrderEvent {
  readonly id: number;
  readonly orderId: number;
  readonly fromStatus: OrderStatus | null;
  readonly toStatus: OrderStatus;
  readonly note: string | null;
  readonly createdAt: string;
  /** `kind:id` (audit-spec.md §2.1); `system:migration` for rows older than the column. */
  readonly actor: string;
  /** Display snapshot at the time of the event; `[erased]` after an erasure (spec §5). */
  readonly actorLabel: string | null;
}

interface OrderRow {
  id: number;
  client_id: number;
  src_lang: string;
  notes: string | null;
  status: OrderStatus;
  word_count: number | null;
  price: number | null;
  created_at: string;
  updated_at: string;
}

function withTgtLangs(db: Database.Database, row: OrderRow): TranslationOrder {
  const tgtLangs = (
    db
      .prepare(
        'SELECT tgt_lang FROM order_target_lang WHERE order_id = ? ORDER BY tgt_lang',
      )
      .all(row.id) as Array<{ tgt_lang: string }>
  ).map((r) => r.tgt_lang);
  return {
    id: row.id,
    clientId: row.client_id,
    srcLang: row.src_lang,
    tgtLangs,
    notes: row.notes,
    status: row.status,
    wordCount: row.word_count,
    price: row.price,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewOrder {
  readonly clientId: number;
  readonly srcLang: string;
  readonly tgtLangs: readonly string[];
  readonly notes?: string | null;
}

export interface OrderWriteOptions {
  /** Who caused it — required (audit-spec.md decision 3). */
  readonly actor: AuditActor;
}

function insertOrderEvent(
  db: Database.Database,
  event: {
    orderId: number;
    fromStatus: OrderStatus | null;
    toStatus: OrderStatus;
    note: string | null;
    createdAt: string;
    actor: AuditActor;
  },
): void {
  db.prepare(
    `INSERT INTO order_event
       (order_id, from_status, to_status, note, created_at, actor, actor_label)
     VALUES (@orderId, @fromStatus, @toStatus, @note, @createdAt, @actor, @actorLabel)`,
  ).run({
    ...event,
    actor: formatActor(event.actor.actor),
    actorLabel: event.actor.label,
  });
}

/** Creates an order in `submitted` status, plus its creation `order_event`. */
export function createOrder(
  db: Database.Database,
  order: NewOrder,
  options: OrderWriteOptions,
): TranslationOrder {
  return db.transaction((): TranslationOrder => {
    const now = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO translation_order
           (client_id, src_lang, notes, status, word_count, price, created_at, updated_at)
         VALUES (@client_id, @src_lang, @notes, 'submitted', NULL, NULL, @now, @now)`,
      )
      .run({
        client_id: order.clientId,
        src_lang: order.srcLang,
        notes: order.notes ?? null,
        now,
      });
    const id = info.lastInsertRowid as number;

    const insertTgt = db.prepare(
      'INSERT INTO order_target_lang (order_id, tgt_lang) VALUES (?, ?)',
    );
    for (const tgtLang of order.tgtLangs) {
      insertTgt.run(id, tgtLang);
    }

    insertOrderEvent(db, {
      orderId: id,
      fromStatus: null,
      toStatus: 'submitted',
      note: 'order created',
      createdAt: now,
      actor: options.actor,
    });

    return withTgtLangs(db, {
      id,
      client_id: order.clientId,
      src_lang: order.srcLang,
      notes: order.notes ?? null,
      status: 'submitted',
      word_count: null,
      price: null,
      created_at: now,
      updated_at: now,
    });
  })();
}

export function getOrder(db: Database.Database, id: number): TranslationOrder | null {
  const row = db.prepare('SELECT * FROM translation_order WHERE id = ?').get(id) as
    OrderRow | undefined;
  return row ? withTgtLangs(db, row) : null;
}

export function listOrders(db: Database.Database): TranslationOrder[] {
  const rows = db
    .prepare('SELECT * FROM translation_order ORDER BY id DESC')
    .all() as OrderRow[];
  return rows.map((row) => withTgtLangs(db, row));
}

export function listOrdersForClient(
  db: Database.Database,
  clientId: number,
): TranslationOrder[] {
  const rows = db
    .prepare('SELECT * FROM translation_order WHERE client_id = ? ORDER BY id DESC')
    .all(clientId) as OrderRow[];
  return rows.map((row) => withTgtLangs(db, row));
}

/**
 * Moves an order to a new status, validating the transition and
 * recording the `order_event` in the same transaction. Throws
 * `InvalidTransitionError` (from `@cat-tool/portal-core`) rather than
 * writing an illegal state.
 */
export interface SetStatusOptions extends OrderWriteOptions {
  readonly note?: string;
}

export function setStatus(
  db: Database.Database,
  orderId: number,
  toStatus: OrderStatus,
  options: SetStatusOptions,
): TranslationOrder {
  return db.transaction((): TranslationOrder => {
    const current = getOrder(db, orderId);
    if (!current) {
      throw new Error(`order ${orderId} not found`);
    }
    assertValidTransition(current.status, toStatus);

    const now = new Date().toISOString();
    db.prepare(
      'UPDATE translation_order SET status = ?, updated_at = ? WHERE id = ?',
    ).run(toStatus, now, orderId);
    insertOrderEvent(db, {
      orderId,
      fromStatus: current.status,
      toStatus,
      note: options.note ?? null,
      createdAt: now,
      actor: options.actor,
    });

    return getOrder(db, orderId)!;
  })();
}

/** Sets the authoritative word count and, with it, the priced total. */
export function setWordCountAndPrice(
  db: Database.Database,
  orderId: number,
  wordCount: number,
  price: number,
): TranslationOrder {
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE translation_order SET word_count = ?, price = ?, updated_at = ? WHERE id = ?',
  ).run(wordCount, price, now, orderId);
  const order = getOrder(db, orderId);
  if (!order) {
    throw new Error(`order ${orderId} not found`);
  }
  return order;
}

export function listOrderEvents(db: Database.Database, orderId: number): OrderEvent[] {
  const rows = db
    .prepare('SELECT * FROM order_event WHERE order_id = ? ORDER BY id')
    .all(orderId) as Array<{
    id: number;
    order_id: number;
    from_status: OrderStatus | null;
    to_status: OrderStatus;
    note: string | null;
    created_at: string;
    actor: string;
    actor_label: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    orderId: r.order_id,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    note: r.note,
    createdAt: r.created_at,
    actor: r.actor,
    actorLabel: r.actor_label,
  }));
}
