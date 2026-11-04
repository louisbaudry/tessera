/**
 * The deadline view (issue #179, `planning/solo-translator-spec.md` D4, D5): open orders grouped by
 * the translator's own due date. A due date is the admin's planning date, never a promise shown to
 * the client (that is #160). Pure, as the rest of `portal-core`.
 */

import type { OrderStatus } from './order.js';

/** A calendar date, `YYYY-MM-DD`. */
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Whether a string is a real calendar date written `YYYY-MM-DD` (no time, no zone). A due date is a
 * day, not an instant: stored as one, it means the same day wherever the translator opens it.
 */
export function isCalendarDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
  );
}

/** What the agenda needs of an order. */
export interface AgendaOrder {
  readonly id: number;
  readonly status: OrderStatus;
  readonly dueAt: string | null;
}

/** Open orders in four groups; each sorted by due date, then id. */
export interface DeadlineAgenda<T extends AgendaOrder> {
  /** Due before today. */
  readonly overdue: readonly T[];
  readonly today: readonly T[];
  readonly later: readonly T[];
  /** No due date set: last, never left out, so an order is not forgotten for lacking one. */
  readonly undated: readonly T[];
}

const OPEN: ReadonlySet<OrderStatus> = new Set(['submitted', 'approved', 'in_progress']);

/**
 * Groups the open orders (not delivered, not cancelled) by their due date against `today`.
 *
 * @param orders - Any orders; closed ones are left out.
 * @param today - The admin's local date, `YYYY-MM-DD` (never the server's UTC date, spec D5).
 * @returns The agenda; dates compare as strings, which `YYYY-MM-DD` orders correctly.
 * @throws RangeError if `today` is not a calendar date.
 */
export function deadlineAgenda<T extends AgendaOrder>(
  orders: readonly T[],
  today: string,
): DeadlineAgenda<T> {
  if (!isCalendarDate(today)) {
    throw new RangeError(`today must be a calendar date (YYYY-MM-DD), got ${today}`);
  }
  const open = orders
    .filter((o) => OPEN.has(o.status))
    .sort((a, b) => {
      const x = a.dueAt ?? '';
      const y = b.dueAt ?? '';
      return x < y ? -1 : x > y ? 1 : a.id - b.id;
    });
  return {
    overdue: open.filter((o) => o.dueAt !== null && o.dueAt < today),
    today: open.filter((o) => o.dueAt === today),
    later: open.filter((o) => o.dueAt !== null && o.dueAt > today),
    undated: open.filter((o) => o.dueAt === null),
  };
}
