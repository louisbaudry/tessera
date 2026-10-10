/**
 * A portal client's vendor pool (backlog #130, vendor-spec.md's #156 note): the
 * roster entries an owner has approved for that client's work. **Absence-based**:
 * a client with no members has no restriction, so a pool only ever narrows what
 * the owner chose to narrow. What it feeds is advice (`assessRoster`'s
 * `not_in_client_pool`), not a gate. Every change names its actor and records one
 * `client_pool.changed` in the roster's own log, in the same transaction; the
 * detail is vendor ids (a roster number), never a name.
 */

import type { AuditActor } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';
import { VendorError } from './error.js';

const isClientId = (id: number): boolean => Number.isSafeInteger(id) && id >= 1;

/** The vendor ids a client has approved, ascending; empty when the client has no pool. */
export function getClientPool(db: Database.Database, portalClientId: number): number[] {
  return (
    db
      .prepare(
        'SELECT vendor_id FROM client_pool_member WHERE portal_client_id = ? ORDER BY vendor_id',
      )
      .all(portalClientId) as Array<{ vendor_id: number }>
  ).map((r) => r.vendor_id);
}

/** Every client that has a pool, with its vendor ids, by client id. */
export function listClientPools(
  db: Database.Database,
): Array<{ portalClientId: number; vendorIds: number[] }> {
  const rows = db
    .prepare(
      'SELECT portal_client_id, vendor_id FROM client_pool_member ORDER BY portal_client_id, vendor_id',
    )
    .all() as Array<{ portal_client_id: number; vendor_id: number }>;
  const byClient = new Map<number, number[]>();
  for (const r of rows) {
    const list = byClient.get(r.portal_client_id);
    if (list) list.push(r.vendor_id);
    else byClient.set(r.portal_client_id, [r.vendor_id]);
  }
  return [...byClient].map(([portalClientId, vendorIds]) => ({
    portalClientId,
    vendorIds,
  }));
}

export interface SetClientPoolOptions {
  readonly portalClientId: number;
  /** The whole pool: every vendor id now approved. Empty clears it (no restriction). */
  readonly vendorIds: readonly number[];
  /** Who changed it — required, never defaulted (audit-spec.md decision 3). */
  readonly actor: AuditActor;
}

export interface ClientPoolChange {
  readonly added: number[];
  readonly removed: number[];
}

/**
 * Replaces a client's pool with `vendorIds` (each a vendor on this roster) and
 * records what joined and what left. A call that changes nothing writes nothing,
 * not even the event.
 */
export function setClientPool(
  db: Database.Database,
  options: SetClientPoolOptions,
): ClientPoolChange {
  if (!isClientId(options.portalClientId)) {
    throw new VendorError('a portal client is a positive whole number');
  }
  const wanted = [...new Set(options.vendorIds)].sort((a, b) => a - b);
  return db.transaction((): ClientPoolChange => {
    for (const id of wanted) {
      if (!db.prepare('SELECT 1 FROM vendor WHERE id = ?').get(id)) {
        throw new VendorError(`no vendor #${id}`);
      }
    }
    const before = getClientPool(db, options.portalClientId);
    const added = wanted.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !wanted.includes(id));
    if (added.length === 0 && removed.length === 0) return { added, removed };
    const insert = db.prepare(
      'INSERT INTO client_pool_member (portal_client_id, vendor_id) VALUES (?, ?)',
    );
    const remove = db.prepare(
      'DELETE FROM client_pool_member WHERE portal_client_id = ? AND vendor_id = ?',
    );
    for (const id of added) insert.run(options.portalClientId, id);
    for (const id of removed) remove.run(options.portalClientId, id);
    appendAuditEvent(db, {
      actor: options.actor,
      action: 'client_pool.changed',
      subjectType: 'client_pool',
      subjectId: String(options.portalClientId),
      detail: { client_id: options.portalClientId, added, removed },
    });
    return { added, removed };
  })();
}
