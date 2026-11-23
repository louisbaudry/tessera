/**
 * The deadline view (issue #179, `planning/solo-translator-spec.md` D4, D5): open orders grouped by
 * the translator's own due date. A due date is the admin's planning date, never a promise shown to
 * the client (that is #160). Pure, as the rest of `portal-core`.
 */

import { isCalendarDate } from '@cat-tool/core/model';

import type { OrderStatus } from './order.js';

/** Defined once in `core/model` (`calendar.ts`); exported here as it always was. */
export { isCalendarDate };

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
