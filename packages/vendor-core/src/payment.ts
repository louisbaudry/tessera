/**
 * The owner's side of a locked payable (`planning/vendor-spec.md`, its #112
 * implementation note): whether it is paid, what is owed per currency, and
 * the CSV a pay run is made from. Pure: rows in, numbers and text out. Which
 * payables exist and what their latest event is, is `db`'s.
 */

import { csvCell } from '@cat-tool/core/model';

/** What a payment event says. A frozen literal in the vendor schema's v5 migration. */
export const PAYMENT_KINDS = ['paid', 'reopened'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

/** A payable's state is its latest event: `paid`, or anything else (none, `reopened`) unpaid. */
export type PaymentStatus = 'unpaid' | 'paid';

export function paymentStatusOf(latest: PaymentKind | null): PaymentStatus {
  return latest === 'paid' ? 'paid' : 'unpaid';
}

/** One locked payable in the ledger. */
export interface LedgerRow {
  readonly assignmentId: number;
  readonly project: string;
  /** What the owner calls the vendor; never an email address. */
  readonly vendorLabel: string;
  /** ISO 4217, or null when no tier had a rate. */
  readonly currency: string | null;
  readonly words: number;
  readonly totalMicros: number;
  /** False when some tier had words and no rate: the total leaves them out. */
  readonly complete: boolean;
  /** ISO timestamp the payable locked at. */
  readonly lockedAt: string;
  readonly status: PaymentStatus;
  /** `YYYY-MM-DD`, set only while paid. */
  readonly paidOn: string | null;
}

export interface CurrencyTotal {
  /** Null for payables with no currency (nothing was priced): they owe 0 and say so. */
  readonly currency: string | null;
  readonly count: number;
  readonly unpaidMicros: number;
  readonly paidMicros: number;
  readonly totalMicros: number;
  /** How many of the `count` have an unpriced tier left out of their total. */
  readonly incomplete: number;
}

/**
 * One total per currency, **never converted**: this product has no exchange
 * rate, and a sum across currencies is a number in none. Sorted by currency,
 * the currency-less group last.
 */
export function totalsByCurrency(rows: readonly LedgerRow[]): CurrencyTotal[] {
  const groups = new Map<string | null, CurrencyTotal>();
  for (const r of rows) {
    const g = groups.get(r.currency) ?? {
      currency: r.currency,
      count: 0,
      unpaidMicros: 0,
      paidMicros: 0,
      totalMicros: 0,
      incomplete: 0,
    };
    groups.set(r.currency, {
      currency: r.currency,
      count: g.count + 1,
      unpaidMicros: g.unpaidMicros + (r.status === 'paid' ? 0 : r.totalMicros),
      paidMicros: g.paidMicros + (r.status === 'paid' ? r.totalMicros : 0),
      totalMicros: g.totalMicros + r.totalMicros,
      incomplete: g.incomplete + (r.complete ? 0 : 1),
    });
  }
  return [...groups.values()].sort((a, b) =>
    a.currency === b.currency
      ? 0
      : a.currency === null
        ? 1
        : b.currency === null
          ? -1
          : a.currency.localeCompare(b.currency),
  );
}

const DAY_MS = 86_400_000;
const dayNumber = (isoDate: string): number => Date.parse(isoDate.slice(0, 10)) / DAY_MS;

/**
 * Whole days from the day a payable locked to the day it was paid, by UTC
 * calendar date (so a payable locked at 23:59 and paid the next day is 1).
 * Negative is impossible for a recorded payment (`recordPayment` refuses it).
 */
export function daysToPay(lockedAt: string, paidOn: string): number {
  return dayNumber(paidOn) - dayNumber(lockedAt);
}

/**
 * An integer count of millionths as a decimal string, with no float in the
 * way: `12_345_600` is `"12.3456"`, `5_000_000` is `"5.00"`. At least two
 * decimals, as many more as the amount needs.
 */
export function formatMicros(micros: number): string {
  if (!Number.isSafeInteger(micros) || micros < 0) {
    throw new RangeError(`${micros} is not an amount of micros`);
  }
  const whole = Math.floor(micros / 1_000_000);
  const frac = String(micros % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/, '');
  return `${whole}.${frac.padEnd(2, '0')}`;
}

export const LEDGER_CSV_COLUMNS = [
  'assignment',
  'project',
  'vendor',
  'currency',
  'words',
  'total',
  'complete',
  'locked_on',
  'status',
  'paid_on',
] as const;

/**
 * The ledger as CSV (RFC 4180, CRLF), one row per payable in the order given.
 * The free-text cells (project, vendor) are neutralised against formula
 * injection; amounts come from the integer micros, never a float.
 */
export function ledgerCsv(rows: readonly LedgerRow[]): string {
  const lines = [LEDGER_CSV_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        String(r.assignmentId),
        csvCell(r.project),
        csvCell(r.vendorLabel),
        r.currency ?? '',
        String(r.words),
        formatMicros(r.totalMicros),
        r.complete ? 'yes' : 'no',
        r.lockedAt.slice(0, 10),
        r.status,
        r.paidOn ?? '',
      ].join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
