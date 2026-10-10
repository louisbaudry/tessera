/**
 * A vendor's last two moves and the payable that locks at delivery
 * (vendor-spec.md decision 10 and its #120 note). The words priced are the
 * analysis frozen at the offer (#49b) and the rates those of the offer's date
 * (#46), so the amount is already immutable; locking stores the computation
 * and its lines, in the delivery's own transaction, immutable by trigger.
 */

import { RATE_TIERS, type RateTier } from '@cat-tool/vendor-core';
import type Database from 'better-sqlite3';

import {
  getAssignmentAnalysis,
  moveAssignment,
  type Assignment,
  type MoveOptions,
} from './assignments.js';
import { VendorError } from './error.js';
import { priceTierWords, type VendorPayable } from './payable.js';
import type { LanguagePair } from './vendors.js';
import { enqueueWebhook } from './webhooks.js';

type VendorMove = Omit<MoveOptions, 'to' | 'by' | 'afterMove'>;

/** A vendor starts work on an accepted job. */
export function startAssignment(db: Database.Database, o: VendorMove): Assignment {
  return moveAssignment(db, { ...o, to: 'in_progress', by: 'vendor' });
}

export interface DeliverOptions extends VendorMove {
  /**
   * The project's language pair, which the rates are per. Null when the project
   * cannot be read any more: the job is delivered all the same, with no payable.
   */
  readonly pair: LanguagePair | null;
}

/**
 * A vendor delivers. The payable is locked in the same transaction: it commits
 * with the move or not at all. A job with nothing to price (no analysis, no
 * pair, a source language with no word count, a card in two currencies) is
 * delivered with no payable row: the vendor's work is done, and a gap in the
 * owner's configuration is not a reason to refuse it.
 */
export function deliverAssignment(
  db: Database.Database,
  options: DeliverOptions,
): Assignment {
  const { pair, ...move } = options;
  return moveAssignment(db, {
    ...move,
    to: 'delivered',
    by: 'vendor',
    afterMove: (tx, moved, at) => lockPayable(tx, moved, pair, at),
  });
}

function lockPayable(
  db: Database.Database,
  assignment: Assignment,
  pair: LanguagePair | null,
  at: string,
): void {
  const analysis = getAssignmentAnalysis(db, assignment.id);
  if (!analysis || !pair || assignment.vendorId === null) return;
  let priced: VendorPayable;
  try {
    priced = priceTierWords(db, {
      vendorId: assignment.vendorId,
      pair,
      words: analysis.words,
      at: assignment.createdAt,
    });
  } catch (err) {
    if (err instanceof VendorError) return;
    throw err;
  }
  db.prepare(
    `INSERT INTO assignment_payable
       (assignment_id, currency, words, total_micros, complete, locked_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    assignment.id,
    priced.currency,
    priced.words,
    priced.totalMicros,
    priced.unpriced.length === 0 ? 1 : 0,
    at,
  );
  const line = db.prepare(
    `INSERT INTO assignment_payable_line
       (assignment_id, tier, words, rate_micros, amount_micros)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const l of priced.lines) {
    line.run(assignment.id, l.tier, l.words, l.rateMicros, l.amountMicros);
  }
  // Reported in the same transaction as the delivery that locked it (vendor-spec.md #125).
  enqueueWebhook(
    db,
    { type: 'payable.locked', at, assignmentId: assignment.id, from: null, to: null },
    at,
  );
}

export interface AssignmentPayable {
  readonly lockedAt: string;
  /** ISO 4217, or null when no tier had a rate. */
  readonly currency: string | null;
  readonly words: number;
  readonly totalMicros: number;
  /** False when some tier had words and no rate: the total leaves them out. */
  readonly complete: boolean;
  readonly lines: ReadonlyArray<{
    readonly tier: RateTier;
    readonly words: number;
    /** Null for a tier the card had no rate for. */
    readonly rateMicros: number | null;
    readonly amountMicros: number;
  }>;
}

/** The payable locked at delivery, or null if the job was not delivered or had nothing to price. */
export function getAssignmentPayable(
  db: Database.Database,
  assignmentId: number,
): AssignmentPayable | null {
  const head = db
    .prepare('SELECT * FROM assignment_payable WHERE assignment_id = ?')
    .get(assignmentId) as
    | {
        currency: string | null;
        words: number;
        total_micros: number;
        complete: number;
        locked_at: string;
      }
    | undefined;
  if (!head) return null;
  const lines = db
    .prepare(
      `SELECT tier, words, rate_micros, amount_micros FROM assignment_payable_line
       WHERE assignment_id = ?`,
    )
    .all(assignmentId) as Array<{
    tier: RateTier;
    words: number;
    rate_micros: number | null;
    amount_micros: number;
  }>;
  return {
    lockedAt: head.locked_at,
    currency: head.currency,
    words: head.words,
    totalMicros: head.total_micros,
    complete: head.complete === 1,
    lines: lines
      .sort((a, b) => RATE_TIERS.indexOf(a.tier) - RATE_TIERS.indexOf(b.tier))
      .map((l) => ({
        tier: l.tier,
        words: l.words,
        rateMicros: l.rate_micros,
        amountMicros: l.amount_micros,
      })),
  };
}
