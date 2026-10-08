/**
 * Payments against locked payables (vendor-spec.md, its #112 note): the
 * owner records that a payable was paid, corrects a wrong record, and lists
 * what is owed. Tessera moves no money; this is the record of it.
 *
 * **The payable is never edited.** `assignment_payable` is immutable by
 * trigger; a payment is an `assignment_payment_event` beside it, append-only,
 * with a required actor, and a payable's state is its latest event. A wrong
 * date is therefore corrected by reopening and paying again, and the log
 * keeps both.
 */

import { formatActor, type AuditActor } from '@cat-tool/core';
import {
  daysToPay,
  paymentStatusOf,
  type LedgerRow,
  type PaymentKind,
  type PaymentStatus,
} from '@cat-tool/vendor-core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';
import { VendorError } from './error.js';
import { utcDate } from './rates.js';

/** The payable is already in the state asked for: a route answers 409. */
export class PaymentConflictError extends VendorError {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentConflictError';
  }
}

/** There is no locked payable to pay (not delivered, or nothing to price): a route answers 404. */
export class NoPayableError extends VendorError {
  constructor(assignmentId: number) {
    super(`assignment #${assignmentId} has no locked payable`);
    this.name = 'NoPayableError';
  }
}

export interface PaymentState {
  readonly assignmentId: number;
  readonly status: PaymentStatus;
  /** `YYYY-MM-DD`, set only while paid. */
  readonly paidOn: string | null;
  /** Whole days from locking to payment, set only while paid. */
  readonly daysToPay: number | null;
}

export interface PaymentEvent {
  readonly id: number;
  readonly assignmentId: number;
  readonly kind: PaymentKind;
  readonly paidOn: string | null;
  readonly actor: string;
  readonly actorLabel: string | null;
  readonly note: string | null;
  readonly at: string;
}

const NOTE_LIMIT = 2000;

function cleanNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim() ?? '';
  if (trimmed.length > NOTE_LIMIT) {
    throw new VendorError(`a payment note is at most ${NOTE_LIMIT} characters`);
  }
  return trimmed === '' ? null : trimmed;
}

interface EventRow {
  id: number;
  assignment_id: number;
  kind: PaymentKind;
  paid_on: string | null;
  actor: string;
  actor_label: string | null;
  note: string | null;
  at: string;
}

const eventFromRow = (r: EventRow): PaymentEvent => ({
  id: r.id,
  assignmentId: r.assignment_id,
  kind: r.kind,
  paidOn: r.paid_on,
  actor: r.actor,
  actorLabel: r.actor_label,
  note: r.note,
  at: r.at,
});

/** A payable's payment history, oldest first. */
export function listPaymentEvents(
  db: Database.Database,
  assignmentId: number,
): PaymentEvent[] {
  return (
    db
      .prepare(
        'SELECT * FROM assignment_payment_event WHERE assignment_id = ? ORDER BY id',
      )
      .all(assignmentId) as EventRow[]
  ).map(eventFromRow);
}

function lockedAtOf(db: Database.Database, assignmentId: number): string | null {
  const row = db
    .prepare('SELECT locked_at FROM assignment_payable WHERE assignment_id = ?')
    .get(assignmentId) as { locked_at: string } | undefined;
  return row?.locked_at ?? null;
}

function latestEvent(db: Database.Database, assignmentId: number): PaymentEvent | null {
  const row = db
    .prepare(
      'SELECT * FROM assignment_payment_event WHERE assignment_id = ? ORDER BY id DESC LIMIT 1',
    )
    .get(assignmentId) as EventRow | undefined;
  return row ? eventFromRow(row) : null;
}

/** The state of a payable, or null if the assignment has no locked payable. */
export function getPaymentState(
  db: Database.Database,
  assignmentId: number,
): PaymentState | null {
  const lockedAt = lockedAtOf(db, assignmentId);
  if (lockedAt === null) return null;
  return stateOf(assignmentId, lockedAt, latestEvent(db, assignmentId));
}

function stateOf(
  assignmentId: number,
  lockedAt: string,
  latest: PaymentEvent | null,
): PaymentState {
  const status = paymentStatusOf(latest?.kind ?? null);
  const paidOn = status === 'paid' ? latest!.paidOn : null;
  return {
    assignmentId,
    status,
    paidOn,
    daysToPay: paidOn === null ? null : daysToPay(lockedAt, paidOn),
  };
}

export interface RecordPaymentOptions {
  readonly assignmentId: number;
  /** The day the money moved, `YYYY-MM-DD`: not the day it was recorded. */
  readonly paidOn: string;
  readonly note?: string | null;
  /** The owner: required (audit-spec.md decision 3). */
  readonly actor: AuditActor;
  readonly now?: Date;
}

/**
 * Records that a locked payable was paid on a date. Refuses a payable that is
 * already paid (reopen it first), a date in the future, and a date before the
 * payable locked: a payment cannot settle what did not yet exist.
 */
export function recordPayment(
  db: Database.Database,
  options: RecordPaymentOptions,
): PaymentState {
  const now = options.now ?? new Date();
  const paidOn = utcDate(options.paidOn);
  if (paidOn !== options.paidOn) throw new VendorError('paidOn is a date: YYYY-MM-DD');
  const note = cleanNote(options.note);
  return db
    .transaction((): PaymentState => {
      const lockedAt = lockedAtOf(db, options.assignmentId);
      if (lockedAt === null) throw new NoPayableError(options.assignmentId);
      if (paidOn > utcDate(now)) {
        throw new VendorError(
          `a payment cannot be dated ${paidOn}, which is in the future`,
        );
      }
      if (paidOn < utcDate(lockedAt)) {
        throw new VendorError(
          `a payment cannot be dated ${paidOn}: the payable locked on ${utcDate(lockedAt)}`,
        );
      }
      const latest = latestEvent(db, options.assignmentId);
      if (paymentStatusOf(latest?.kind ?? null) === 'paid') {
        throw new PaymentConflictError(
          `assignment #${options.assignmentId} is already paid (on ${latest!.paidOn}): ` +
            `reopen it to correct the record`,
        );
      }
      const event = append(db, {
        assignmentId: options.assignmentId,
        kind: 'paid',
        paidOn,
        note,
        actor: options.actor,
        at: now.toISOString(),
      });
      return stateOf(options.assignmentId, lockedAt, event);
    })
    .immediate();
}

export interface ReopenPaymentOptions {
  readonly assignmentId: number;
  readonly note?: string | null;
  readonly actor: AuditActor;
  readonly now?: Date;
}

/** Withdraws a payment record, to correct it: only a paid payable can be reopened. */
export function reopenPayment(
  db: Database.Database,
  options: ReopenPaymentOptions,
): PaymentState {
  const now = options.now ?? new Date();
  const note = cleanNote(options.note);
  return db
    .transaction((): PaymentState => {
      const lockedAt = lockedAtOf(db, options.assignmentId);
      if (lockedAt === null) throw new NoPayableError(options.assignmentId);
      const latest = latestEvent(db, options.assignmentId);
      if (paymentStatusOf(latest?.kind ?? null) !== 'paid') {
        throw new PaymentConflictError(
          `assignment #${options.assignmentId} is not paid: there is nothing to reopen`,
        );
      }
      const event = append(db, {
        assignmentId: options.assignmentId,
        kind: 'reopened',
        paidOn: null,
        note,
        actor: options.actor,
        at: now.toISOString(),
      });
      return stateOf(options.assignmentId, lockedAt, event);
    })
    .immediate();
}

function append(
  db: Database.Database,
  o: {
    assignmentId: number;
    kind: PaymentKind;
    paidOn: string | null;
    note: string | null;
    actor: AuditActor;
    at: string;
  },
): PaymentEvent {
  const info = db
    .prepare(
      `INSERT INTO assignment_payment_event
         (assignment_id, kind, paid_on, actor, actor_label, note, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      o.assignmentId,
      o.kind,
      o.paidOn,
      formatActor(o.actor.actor),
      o.actor.label,
      o.note,
      o.at,
    );
  return eventFromRow(
    db
      .prepare('SELECT * FROM assignment_payment_event WHERE id = ?')
      .get(info.lastInsertRowid) as EventRow,
  );
}

export interface LedgerFilter {
  /** One vendor, by roster id. */
  readonly vendorId?: number;
  /** Inclusive, by the day the payable locked (`YYYY-MM-DD`). */
  readonly from?: string;
  readonly to?: string;
  readonly status?: PaymentStatus;
}

/** A ledger row with the ids a route needs to name the vendor and the job. */
export interface LedgerEntry extends LedgerRow {
  readonly vendorId: number;
  readonly vendorAccountId: number;
}

interface LedgerSqlRow {
  assignment_id: number;
  project_name: string;
  vendor_id: number;
  account_id: number;
  display_name: string | null;
  currency: string | null;
  words: number;
  total_micros: number;
  complete: number;
  locked_at: string;
  latest_kind: PaymentKind | null;
  latest_paid_on: string | null;
}

function checkDay(day: string | undefined, what: string): string | undefined {
  if (day === undefined) return undefined;
  if (utcDate(day) !== day) throw new VendorError(`${what} is a date: YYYY-MM-DD`);
  return day;
}

/**
 * Every locked payable matching the filter, newest lock first. The period is
 * the day a payable locked, the one date every payable has and the one that
 * never moves. A payable with no rate for some tier is listed with
 * `complete: false`, never hidden.
 */
export function listLedger(
  db: Database.Database,
  filter: LedgerFilter = {},
): LedgerEntry[] {
  const from = checkDay(filter.from, 'from');
  const to = checkDay(filter.to, 'to');
  if (from !== undefined && to !== undefined && from > to) {
    throw new VendorError('from is after to');
  }
  const rows = db
    .prepare(
      `SELECT p.assignment_id, a.project_name, a.vendor_id, v.account_id, v.display_name,
              p.currency, p.words, p.total_micros, p.complete, p.locked_at,
              (SELECT e.kind FROM assignment_payment_event e
                WHERE e.assignment_id = p.assignment_id ORDER BY e.id DESC LIMIT 1) AS latest_kind,
              (SELECT e.paid_on FROM assignment_payment_event e
                WHERE e.assignment_id = p.assignment_id ORDER BY e.id DESC LIMIT 1) AS latest_paid_on
         FROM assignment_payable p
         JOIN assignment a ON a.id = p.assignment_id
         JOIN vendor v ON v.id = a.vendor_id
        WHERE (@vendor IS NULL OR a.vendor_id = @vendor)
          AND (@from IS NULL OR substr(p.locked_at, 1, 10) >= @from)
          AND (@to IS NULL OR substr(p.locked_at, 1, 10) <= @to)
        ORDER BY p.locked_at DESC, p.assignment_id DESC`,
    )
    .all({
      vendor: filter.vendorId ?? null,
      from: from ?? null,
      to: to ?? null,
    }) as LedgerSqlRow[];
  return rows
    .map((r): LedgerEntry => {
      const status = paymentStatusOf(r.latest_kind);
      return {
        assignmentId: r.assignment_id,
        project: r.project_name,
        vendorId: r.vendor_id,
        vendorAccountId: r.account_id,
        vendorLabel: r.display_name ?? `account ${r.account_id}`,
        currency: r.currency,
        words: r.words,
        totalMicros: r.total_micros,
        complete: r.complete === 1,
        lockedAt: r.locked_at,
        status,
        paidOn: status === 'paid' ? r.latest_paid_on : null,
      };
    })
    .filter((r) => filter.status === undefined || r.status === filter.status);
}

/**
 * Records that the payables CSV left the system: a row count and the digest of
 * the bytes, never a name or an amount (a detail is hashed, so erasure could
 * not reach one). Written by the route that sends the file.
 */
export function recordLedgerExport(
  db: Database.Database,
  options: { readonly rows: number; readonly sha256: string; readonly actor: AuditActor },
): void {
  appendAuditEvent(db, {
    actor: options.actor,
    action: 'payables.exported',
    subjectType: 'payables',
    subjectId: null,
    detail: { rows: options.rows, sha256: options.sha256 },
  });
}
