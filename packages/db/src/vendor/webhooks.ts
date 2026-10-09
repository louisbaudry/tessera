/**
 * The webhook endpoints and their outbox (`planning/vendor-spec.md`, its #125
 * note). An endpoint is a URL the owner registered; a delivery is a queued POST
 * written in the same transaction as the event it reports, so a committed event
 * is sent at least once and a rolled-back one never is. This module keeps the
 * queue and its bookkeeping; what the body says, how it is signed and which
 * addresses may be called are `vendor-core`'s, and the request itself is the
 * server's.
 */
import type { AuditActor } from '@cat-tool/core';
import {
  eventForStatus,
  generateWebhookSecret,
  MAX_PENDING_WEBHOOKS,
  MAX_WEBHOOK_ENDPOINTS,
  nextAttemptDelayMs,
  serializeWebhookBody,
  validateWebhookUrl,
  WEBHOOK_KEEP_DELIVERED_DAYS,
  WEBHOOK_KEEP_FAILED_DAYS,
  type WebhookBody,
  type WebhookDeliveryStatus,
  type WebhookEventType,
} from '@cat-tool/vendor-core/webhook';
import type { AssignmentStatus } from '@cat-tool/vendor-core';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';
import { VendorError } from './error.js';

/** A registered endpoint as the owner sees it: never the secret, never the path or query. */
export interface WebhookEndpointView {
  readonly id: number;
  readonly host: string;
  readonly createdAt: string;
  readonly pending: number;
  readonly delivered: number;
  readonly failed: number;
  /** The HTTP status of the most recent attempt that got an answer, or null. */
  readonly lastStatus: number | null;
  /** When the most recent attempt settled or was last tried, or null. */
  readonly lastAttemptAt: string | null;
}

/**
 * Registers an endpoint. The URL must pass `validateWebhookUrl` (the address is
 * checked again on every attempt, since DNS can change). Returns the secret
 * exactly once: only this response ever carries it. Logged as `webhook.created`
 * with the host alone as detail.
 *
 * @throws VendorError for a URL that is not acceptable or a fourth endpoint.
 */
export function addWebhookEndpoint(
  db: Database.Database,
  options: { readonly url: string; readonly actor: AuditActor; readonly now?: Date },
): { readonly id: number; readonly host: string; readonly secret: string } {
  const checked = validateWebhookUrl(options.url.trim());
  if (!checked.ok) throw new VendorError(checked.reason);
  const secret = generateWebhookSecret();
  const at = (options.now ?? new Date()).toISOString();
  return db.transaction(() => {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM webhook_endpoint').get() as {
      n: number;
    };
    if (n >= MAX_WEBHOOK_ENDPOINTS) {
      throw new VendorError(`at most ${MAX_WEBHOOK_ENDPOINTS} webhook endpoints`);
    }
    const id = Number(
      db
        .prepare(
          `INSERT INTO webhook_endpoint (url, host, secret, created_at) VALUES (?, ?, ?, ?)`,
        )
        .run(checked.url.toString(), checked.host, secret, at).lastInsertRowid,
    );
    appendAuditEvent(db, {
      actor: options.actor,
      action: 'webhook.created',
      subjectType: 'webhook_endpoint',
      subjectId: String(id),
      detail: { host: checked.host },
    });
    return { id, host: checked.host, secret };
  })();
}

/** Every endpoint with its delivery counts, oldest first. Never the secret or the full URL. */
export function listWebhookEndpoints(db: Database.Database): WebhookEndpointView[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.host, e.created_at AS createdAt,
              (SELECT COUNT(*) FROM webhook_delivery d WHERE d.endpoint_id = e.id AND d.status = 'pending') AS pending,
              (SELECT COUNT(*) FROM webhook_delivery d WHERE d.endpoint_id = e.id AND d.status = 'delivered') AS delivered,
              (SELECT COUNT(*) FROM webhook_delivery d WHERE d.endpoint_id = e.id AND d.status = 'failed') AS failed,
              (SELECT d.last_status FROM webhook_delivery d
                WHERE d.endpoint_id = e.id AND d.last_status IS NOT NULL
                ORDER BY d.rowid DESC LIMIT 1) AS lastStatus,
              (SELECT COALESCE(d.settled_at, d.next_attempt_at) FROM webhook_delivery d
                WHERE d.endpoint_id = e.id AND d.attempts > 0
                ORDER BY d.rowid DESC LIMIT 1) AS lastAttemptAt
         FROM webhook_endpoint e ORDER BY e.id`,
    )
    .all() as WebhookEndpointView[];
  return rows;
}

/**
 * Removes an endpoint and its queue, logged as `webhook.deleted`. Returns false
 * when there is no such endpoint, so a route can answer 404.
 */
export function deleteWebhookEndpoint(
  db: Database.Database,
  options: { readonly id: number; readonly actor: AuditActor },
): boolean {
  return db.transaction(() => {
    const row = db
      .prepare('SELECT host FROM webhook_endpoint WHERE id = ?')
      .get(options.id) as { host: string } | undefined;
    if (!row) return false;
    db.prepare('DELETE FROM webhook_delivery WHERE endpoint_id = ?').run(options.id);
    db.prepare('DELETE FROM webhook_endpoint WHERE id = ?').run(options.id);
    appendAuditEvent(db, {
      actor: options.actor,
      action: 'webhook.deleted',
      subjectType: 'webhook_endpoint',
      subjectId: String(options.id),
      detail: { host: row.host },
    });
    return true;
  })();
}

/** What an event is, before it is written once per endpoint. */
export interface WebhookEvent {
  readonly type: WebhookEventType;
  /** When the event happened (ISO), not when it is queued. */
  readonly at: string;
  readonly assignmentId: number | null;
  readonly from: AssignmentStatus | null;
  readonly to: AssignmentStatus | null;
}

function vendorAccountOf(
  db: Database.Database,
  assignmentId: number | null,
): number | null {
  if (assignmentId === null) return null;
  const row = db
    .prepare(
      `SELECT v.account_id AS accountId
         FROM assignment a LEFT JOIN vendor v ON v.id = a.vendor_id WHERE a.id = ?`,
    )
    .get(assignmentId) as { accountId: number | null } | undefined;
  return row?.accountId ?? null;
}

function insertDelivery(
  db: Database.Database,
  endpointId: number,
  event: WebhookEvent,
  vendorAccountId: number | null,
  now: string,
): void {
  const { n } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM webhook_delivery WHERE endpoint_id = ? AND status = 'pending'`,
    )
    .get(endpointId) as { n: number };
  const id = randomUUID();
  const body: WebhookBody = {
    id,
    type: event.type,
    createdAt: event.at,
    assignmentId: event.assignmentId,
    from: event.from,
    to: event.to,
    vendorAccountId,
  };
  const full = n >= MAX_PENDING_WEBHOOKS;
  db.prepare(
    `INSERT INTO webhook_delivery
       (id, endpoint_id, event_type, body, status, attempts, next_attempt_at,
        last_error, created_at, settled_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
  ).run(
    id,
    endpointId,
    event.type,
    serializeWebhookBody(body),
    full ? 'failed' : 'pending',
    now,
    full ? 'queue full' : null,
    now,
    full ? now : null,
  );
}

/**
 * Queues `event` for every endpoint. Called from inside the transaction that
 * writes the event it reports (`appendEvent`, the payable lock), so the queue
 * and the log can never disagree. A queue already at `MAX_PENDING_WEBHOOKS` for
 * an endpoint takes the row as `failed` (`queue full`) instead of growing.
 * Returns how many rows were written.
 */
export function enqueueWebhook(
  db: Database.Database,
  event: WebhookEvent,
  now: string = new Date().toISOString(),
): number {
  const endpoints = db
    .prepare('SELECT id FROM webhook_endpoint ORDER BY id')
    .all() as Array<{
    id: number;
  }>;
  if (endpoints.length === 0) return 0;
  const vendorAccountId = vendorAccountOf(db, event.assignmentId);
  for (const e of endpoints) insertDelivery(db, e.id, event, vendorAccountId, now);
  return endpoints.length;
}

/** The event an assignment entering `to` is reported as, for `appendEvent`. */
export function assignmentWebhookEvent(options: {
  readonly assignmentId: number;
  readonly from: AssignmentStatus | null;
  readonly to: AssignmentStatus;
  readonly at: string;
}): WebhookEvent {
  return {
    type: eventForStatus(options.to),
    at: options.at,
    assignmentId: options.assignmentId,
    from: options.from,
    to: options.to,
  };
}

/** Queues a `ping` for one endpoint (the owner's "send a test"). False when there is none. */
export function enqueueWebhookPing(
  db: Database.Database,
  endpointId: number,
  now: Date = new Date(),
): boolean {
  const exists = db
    .prepare('SELECT 1 FROM webhook_endpoint WHERE id = ?')
    .get(endpointId);
  if (!exists) return false;
  const at = now.toISOString();
  insertDelivery(
    db,
    endpointId,
    { type: 'ping', at, assignmentId: null, from: null, to: null },
    null,
    at,
  );
  return true;
}

/** A queued delivery with what is needed to send it. */
export interface DueWebhook {
  readonly id: string;
  readonly endpointId: number;
  readonly url: string;
  readonly secret: string;
  readonly eventType: WebhookEventType;
  readonly body: string;
  readonly attempts: number;
}

/** Pending deliveries whose time has come, oldest first, at most `limit`. */
export function dueWebhooks(db: Database.Database, now: Date, limit = 20): DueWebhook[] {
  return db
    .prepare(
      `SELECT d.id AS id, d.endpoint_id AS endpointId, e.url AS url, e.secret AS secret,
              d.event_type AS eventType, d.body AS body, d.attempts AS attempts
         FROM webhook_delivery d JOIN webhook_endpoint e ON e.id = d.endpoint_id
        WHERE d.status = 'pending' AND d.next_attempt_at <= ?
        ORDER BY d.next_attempt_at, d.rowid LIMIT ?`,
    )
    .all(now.toISOString(), limit) as DueWebhook[];
}

/** The earliest time any pending delivery is due, or null when none is pending. */
export function nextWebhookDue(db: Database.Database): string | null {
  const row = db
    .prepare(
      `SELECT MIN(next_attempt_at) AS at FROM webhook_delivery WHERE status = 'pending'`,
    )
    .get() as { at: string | null };
  return row.at;
}

/** What an attempt came to. */
export interface WebhookAttempt {
  /** True for a `2xx` answer. */
  readonly ok: boolean;
  /** The HTTP status, when the receiver answered. */
  readonly httpStatus: number | null;
  /** A short class (`timeout`, `refused`, `address`, `http`…): never a response body. */
  readonly error: string | null;
}

/**
 * Records one attempt: `delivered` on success; otherwise it is tried again after
 * the next delay, or `failed` for good once the schedule is spent. Returns the
 * state the delivery is in now.
 */
export function settleWebhook(
  db: Database.Database,
  id: string,
  attempt: WebhookAttempt,
  now: Date = new Date(),
): WebhookDeliveryStatus {
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT attempts FROM webhook_delivery WHERE id = ? AND status = 'pending'`,
      )
      .get(id) as { attempts: number } | undefined;
    if (!row) throw new VendorError(`no pending webhook delivery ${id}`);
    const attempts = row.attempts + 1;
    const at = now.toISOString();
    if (attempt.ok) {
      db.prepare(
        `UPDATE webhook_delivery
            SET status = 'delivered', attempts = ?, last_status = ?, last_error = NULL, settled_at = ?
          WHERE id = ?`,
      ).run(attempts, attempt.httpStatus, at, id);
      return 'delivered';
    }
    const delay = nextAttemptDelayMs(attempts);
    if (delay === null) {
      db.prepare(
        `UPDATE webhook_delivery
            SET status = 'failed', attempts = ?, last_status = ?, last_error = ?, settled_at = ?
          WHERE id = ?`,
      ).run(attempts, attempt.httpStatus, attempt.error, at, id);
      return 'failed';
    }
    db.prepare(
      `UPDATE webhook_delivery
          SET attempts = ?, last_status = ?, last_error = ?, next_attempt_at = ?
        WHERE id = ?`,
    ).run(
      attempts,
      attempt.httpStatus,
      attempt.error,
      new Date(now.getTime() + delay).toISOString(),
      id,
    );
    return 'pending';
  })();
}

/** Drops delivered rows older than 14 days and failed ones older than 30. Returns how many. */
export function pruneWebhooks(db: Database.Database, now: Date = new Date()): number {
  const day = 86_400_000;
  const delivered = new Date(
    now.getTime() - WEBHOOK_KEEP_DELIVERED_DAYS * day,
  ).toISOString();
  const failed = new Date(now.getTime() - WEBHOOK_KEEP_FAILED_DAYS * day).toISOString();
  return (
    db
      .prepare(
        `DELETE FROM webhook_delivery WHERE status = 'delivered' AND settled_at < ?`,
      )
      .run(delivered).changes +
    db
      .prepare(`DELETE FROM webhook_delivery WHERE status = 'failed' AND settled_at < ?`)
      .run(failed).changes
  );
}
