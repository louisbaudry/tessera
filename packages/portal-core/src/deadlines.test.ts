import { describe, expect, it } from 'vitest';

import { deadlineAgenda, isCalendarDate, type AgendaOrder } from './deadlines.js';

const order = (
  id: number,
  dueAt: string | null,
  status: AgendaOrder['status'] = 'approved',
) => ({
  id,
  dueAt,
  status,
});

describe('deadlineAgenda (issue #179, solo-translator-spec D5)', () => {
  it('groups open orders against today, sorted by date then id, undated last', () => {
    const agenda = deadlineAgenda(
      [
        order(1, '2026-11-10'),
        order(2, null),
        order(3, '2026-11-01'),
        order(4, '2026-11-04'),
        order(5, '2026-11-10', 'in_progress'),
        order(6, '2026-11-03', 'submitted'),
      ],
      '2026-11-04',
    );
    expect(agenda.overdue.map((o) => o.id)).toEqual([3, 6]);
    expect(agenda.today.map((o) => o.id)).toEqual([4]);
    expect(agenda.later.map((o) => o.id)).toEqual([1, 5]);
    expect(agenda.undated.map((o) => o.id)).toEqual([2]);
  });

  it('leaves delivered and cancelled orders out, however overdue', () => {
    const agenda = deadlineAgenda(
      [
        order(1, '2026-01-01', 'delivered'),
        order(2, '2026-01-01', 'cancelled'),
        order(3, null, 'delivered'),
      ],
      '2026-11-04',
    );
    expect([
      ...agenda.overdue,
      ...agenda.today,
      ...agenda.later,
      ...agenda.undated,
    ]).toEqual([]);
  });

  it('refuses a today that is not a calendar date', () => {
    expect(() => deadlineAgenda([], '2026-11-04T00:00:00Z')).toThrow(RangeError);
  });
});

describe('isCalendarDate', () => {
  it('accepts a real day and refuses the rest', () => {
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('2026-1-01')).toBe(false);
    expect(isCalendarDate('')).toBe(false);
  });
});
