import { describe, expect, it } from 'vitest';

import type { CurrencyTotal } from '@cat-tool/vendor-core';

import {
  amountLabel,
  amountNote,
  daysToPayLabel,
  filterProblem,
  NO_FILTER,
  paidOnProblem,
  payablesQuery,
  statusLabel,
  todayUtc,
  totalLines,
} from './payables.js';

describe('payablesQuery', () => {
  it('is empty with no filter, so the list and the CSV are the unfiltered ledger', () => {
    expect(payablesQuery(NO_FILTER)).toBe('');
  });

  it('carries only the filters that are set', () => {
    expect(payablesQuery({ ...NO_FILTER, status: 'unpaid' })).toBe('?status=unpaid');
    expect(
      payablesQuery({
        vendor: '7',
        from: '2026-09-01',
        to: '2026-09-30',
        status: 'paid',
      }),
    ).toBe('?vendor=7&from=2026-09-01&to=2026-09-30&status=paid');
  });

  it('escapes what a hand-typed value could smuggle in', () => {
    expect(payablesQuery({ ...NO_FILTER, vendor: '7&status=paid' })).toBe(
      '?vendor=7%26status%3Dpaid',
    );
  });
});

describe('filterProblem', () => {
  it('refuses a period that ends before it starts, and nothing else', () => {
    expect(
      filterProblem({ ...NO_FILTER, from: '2026-09-30', to: '2026-09-01' }),
    ).not.toBe(null);
    expect(filterProblem({ ...NO_FILTER, from: '2026-09-01', to: '2026-09-01' })).toBe(
      null,
    );
    expect(filterProblem({ ...NO_FILTER, from: '2026-09-30' })).toBe(null);
    expect(filterProblem({ ...NO_FILTER, to: '2026-09-01' })).toBe(null);
  });
});

describe('amountLabel / amountNote', () => {
  const whole = { currency: 'EUR', totalMicros: 26_560_000, complete: true };

  it('writes money in its currency, from the micros', () => {
    expect(amountLabel(whole, 'en-US')).toBe('€26.56');
    expect(amountNote(whole)).toBe(null);
  });

  it('flags an incomplete payable and never presents the part as the whole', () => {
    const partial = { ...whole, complete: false };
    expect(amountLabel(partial, 'en-US')).toBe('€26.56');
    expect(amountNote(partial)).toMatch(/no rate/);
  });

  it('does not write a payable with no currency as zero', () => {
    const unpriced = { currency: null, totalMicros: 0, complete: false };
    expect(amountLabel(unpriced, 'en-US')).toBe('Not priced');
    expect(amountNote(unpriced)).toMatch(/nothing is owed/);
  });
});

describe('totalLines', () => {
  const totals: CurrencyTotal[] = [
    {
      currency: 'EUR',
      count: 3,
      unpaidMicros: 10_000_000,
      paidMicros: 5_000_000,
      totalMicros: 15_000_000,
      incomplete: 1,
    },
    {
      currency: 'USD',
      count: 1,
      unpaidMicros: 0,
      paidMicros: 2_500_000,
      totalMicros: 2_500_000,
      incomplete: 0,
    },
    {
      currency: null,
      count: 2,
      unpaidMicros: 0,
      paidMicros: 0,
      totalMicros: 0,
      incomplete: 2,
    },
  ];

  it('is one line per currency, each in its own unit, never summed across', () => {
    const lines = totalLines(totals, 'en-US');
    expect(lines.map((l) => l.key)).toEqual(['EUR', 'USD', 'none']);
    expect(lines[0]).toMatchObject({
      unpaid: '€10.00',
      paid: '€5.00',
      total: '€15.00',
      incomplete: '1 payable has an unpriced tier',
    });
    expect(lines[1]).toMatchObject({ total: '$2.50', incomplete: null });
  });

  it('shows no amounts for the group with no currency, only why', () => {
    const none = totalLines(totals, 'en-US')[2]!;
    expect([none.unpaid, none.paid, none.total]).toEqual(['—', '—', '—']);
    expect(none.incomplete).toBe('2 payables have an unpriced tier');
    expect(none.count).toBe(2);
  });

  it('is empty when nothing matched', () => {
    expect(totalLines([])).toEqual([]);
  });
});

describe('paidOnProblem', () => {
  const locked = '2026-09-10T22:30:00.000Z';
  const today = '2026-10-01';

  it('accepts the day it locked, a day between, and today', () => {
    expect(paidOnProblem('2026-09-10', locked, today)).toBe(null);
    expect(paidOnProblem('2026-09-20', locked, today)).toBe(null);
    expect(paidOnProblem('2026-10-01', locked, today)).toBe(null);
  });

  it('refuses the future, a day before it locked, and a missing date', () => {
    expect(paidOnProblem('2026-10-02', locked, today)).toMatch(/future/);
    expect(paidOnProblem('2026-09-09', locked, today)).toMatch(/2026-09-10/);
    expect(paidOnProblem('', locked, today)).toMatch(/Pick/);
    expect(paidOnProblem('10/01/2026', locked, today)).toMatch(/Pick/);
  });

  it('counts today by UTC date, as the server does, not by the browser clock', () => {
    // 01:00 on 2 October in UTC+10 is still 1 October in UTC.
    expect(todayUtc(new Date('2026-10-01T15:00:00Z'))).toBe('2026-10-01');
    expect(todayUtc(new Date('2026-10-02T00:00:00Z'))).toBe('2026-10-02');
  });
});

describe('statusLabel / daysToPayLabel', () => {
  it('says Unpaid, or when and how long it took', () => {
    expect(statusLabel({ status: 'unpaid', paidOn: null, daysToPay: null })).toBe(
      'Unpaid',
    );
    expect(statusLabel({ status: 'paid', paidOn: '2026-09-20', daysToPay: 10 })).toBe(
      'Paid 2026-09-20 (10 days)',
    );
    expect(statusLabel({ status: 'paid', paidOn: '2026-09-10', daysToPay: 0 })).toBe(
      'Paid 2026-09-10 (same day)',
    );
    expect(daysToPayLabel(1)).toBe('1 day');
    expect(daysToPayLabel(null)).toBe(null);
  });
});
