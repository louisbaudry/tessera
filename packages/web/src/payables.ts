/**
 * What the payables screens decide, kept out of the components (backlog #113;
 * `vendor-spec.md`, the #112 note): how a filter becomes the query the routes
 * read, how a total reads when each currency stands alone, what a row says
 * about itself, and which dates the server will accept. Pure, so it is proved
 * in node. The ledger, the totals and the payment rules are `vendor-core`'s and
 * `db`'s; nothing here re-derives a sum or a state.
 */
import type { CurrencyTotal, PaymentStatus } from '@cat-tool/vendor-core';

import { formatMicros } from './jobs.js';

/** The owner's pay-run filters as typed: empty text is "no filter". */
export interface PayablesFilter {
  /** A vendor's account id, or empty for every vendor on the roster. */
  readonly vendor: string;
  /** `YYYY-MM-DD`, the day a payable locked, inclusive; empty is open-ended. */
  readonly from: string;
  readonly to: string;
  readonly status: '' | PaymentStatus;
}

export const NO_FILTER: PayablesFilter = { vendor: '', from: '', to: '', status: '' };

/**
 * `?vendor=&from=&to=&status=` with only the filters that are set, or `''`.
 * Shared by the list and the CSV link so a download is always the list on screen.
 */
export function payablesQuery(filter: PayablesFilter): string {
  const params = new URLSearchParams();
  for (const key of ['vendor', 'from', 'to', 'status'] as const) {
    if (filter[key] !== '') params.set(key, filter[key]);
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/** Why a filter cannot be sent, or null: a period that ends before it starts matches nothing. */
export function filterProblem(filter: PayablesFilter): string | null {
  if (filter.from !== '' && filter.to !== '' && filter.from > filter.to) {
    return 'The period ends before it starts.';
  }
  return null;
}

/** The money shapes both screens share: an amount in micros of one currency, or none. */
interface Priced {
  readonly currency: string | null;
  readonly totalMicros: number;
  readonly complete: boolean;
}

/**
 * A payable's amount. One with no currency had no rate for any tier, so there
 * is no amount to show and it is **not** written as zero: "Not priced".
 */
export function amountLabel(row: Priced, locale?: string): string {
  if (row.currency === null) return 'Not priced';
  return formatMicros(row.totalMicros, row.currency, locale);
}

/**
 * What a row says about its own amount, or null when it is whole. An
 * incomplete payable is listed with this, never hidden: the owner pays what
 * was priced and sees what was left out (the #112 note).
 */
export function amountNote(row: Priced): string | null {
  if (row.currency === null) return 'No tier had a rate: nothing is owed on it yet.';
  return row.complete ? null : 'A tier had no rate: its words are not in this amount.';
}

/** One currency's line in the totals: each stands alone, nothing is converted. */
export interface TotalLine {
  readonly key: string;
  readonly currency: string | null;
  readonly count: number;
  readonly unpaid: string;
  readonly paid: string;
  readonly total: string;
  /** How many of the payables have an unpriced tier, as words; null when none do. */
  readonly incomplete: string | null;
}

/**
 * The server's totals as lines, one per currency. The currency-less group has
 * no unit, so it shows no amounts at all, only its count and the reason.
 */
export function totalLines(
  totals: readonly CurrencyTotal[],
  locale?: string,
): TotalLine[] {
  return totals.map((t) => {
    const incomplete =
      t.incomplete === 0
        ? null
        : t.incomplete === 1
          ? '1 payable has an unpriced tier'
          : `${t.incomplete} payables have an unpriced tier`;
    if (t.currency === null) {
      return {
        key: 'none',
        currency: null,
        count: t.count,
        unpaid: '—',
        paid: '—',
        total: '—',
        incomplete: incomplete ?? 'Not priced',
      };
    }
    return {
      key: t.currency,
      currency: t.currency,
      count: t.count,
      unpaid: formatMicros(t.unpaidMicros, t.currency, locale),
      paid: formatMicros(t.paidMicros, t.currency, locale),
      total: formatMicros(t.totalMicros, t.currency, locale),
      incomplete,
    };
  });
}

/**
 * Today as the server counts it: a UTC calendar date. A payment may not be
 * dated after it, so a default or a `max` taken from the browser's own day
 * would be refused for anyone east of Greenwich in the first hours of theirs.
 */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` of an ISO timestamp (the day a payable locked, by UTC date). */
export const dayOf = (iso: string): string => iso.slice(0, 10);

/**
 * Why a payment date would be refused, or null. The server has the last word
 * (`recordPayment`); this only spares a round trip for the two rules a person
 * can see: not in the future, and not before the payable locked.
 */
export function paidOnProblem(
  paidOn: string,
  lockedAt: string,
  today: string = todayUtc(),
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) return 'Pick the day the money moved.';
  if (paidOn > today) return 'A payment cannot be dated in the future.';
  if (paidOn < dayOf(lockedAt)) {
    return `The payable locked on ${dayOf(lockedAt)}; it cannot have been paid before.`;
  }
  return null;
}

/** "Paid 12 days after locking", "Paid the day it locked": the vendor's wait, in words. */
export function daysToPayLabel(days: number | null): string | null {
  if (days === null) return null;
  if (days === 0) return 'same day';
  return days === 1 ? '1 day' : `${days} days`;
}

/** The paid column: the date, and how long it took, or "Unpaid". */
export function statusLabel(row: {
  readonly status: PaymentStatus;
  readonly paidOn: string | null;
  readonly daysToPay: number | null;
}): string {
  if (row.status !== 'paid' || row.paidOn === null) return 'Unpaid';
  const wait = daysToPayLabel(row.daysToPay);
  return wait === null ? `Paid ${row.paidOn}` : `Paid ${row.paidOn} (${wait})`;
}
