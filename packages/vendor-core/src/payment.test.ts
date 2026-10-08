import { describe, expect, it } from 'vitest';

import {
  daysToPay,
  formatMicros,
  ledgerCsv,
  paymentStatusOf,
  totalsByCurrency,
  type LedgerRow,
} from './payment.js';

const row = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  assignmentId: 1,
  project: 'brochure',
  vendorLabel: 'Ana',
  currency: 'EUR',
  words: 1000,
  totalMicros: 100_000_000,
  complete: true,
  lockedAt: '2026-03-01T10:00:00.000Z',
  status: 'unpaid',
  paidOn: null,
  ...over,
});

describe('paymentStatusOf', () => {
  it('reads the latest event: only `paid` is paid', () => {
    expect(paymentStatusOf(null)).toBe('unpaid');
    expect(paymentStatusOf('reopened')).toBe('unpaid');
    expect(paymentStatusOf('paid')).toBe('paid');
  });
});

describe('totalsByCurrency', () => {
  it('keeps one total per currency and never adds across them', () => {
    const totals = totalsByCurrency([
      row({ assignmentId: 1, totalMicros: 10_000_000 }),
      row({
        assignmentId: 2,
        totalMicros: 5_000_000,
        status: 'paid',
        paidOn: '2026-03-05',
      }),
      row({ assignmentId: 3, currency: 'USD', totalMicros: 7_000_000 }),
    ]);
    expect(totals).toEqual([
      {
        currency: 'EUR',
        count: 2,
        unpaidMicros: 10_000_000,
        paidMicros: 5_000_000,
        totalMicros: 15_000_000,
        incomplete: 0,
      },
      {
        currency: 'USD',
        count: 1,
        unpaidMicros: 7_000_000,
        paidMicros: 0,
        totalMicros: 7_000_000,
        incomplete: 0,
      },
    ]);
  });

  it('counts an incomplete payable and puts the currency-less group last', () => {
    const totals = totalsByCurrency([
      row({ assignmentId: 1, currency: null, totalMicros: 0, complete: false }),
      row({ assignmentId: 2, complete: false, totalMicros: 4_000_000 }),
    ]);
    expect(totals.map((t) => [t.currency, t.incomplete, t.totalMicros])).toEqual([
      ['EUR', 1, 4_000_000],
      [null, 1, 0],
    ]);
  });

  it('is empty for no rows', () => {
    expect(totalsByCurrency([])).toEqual([]);
  });
});

describe('daysToPay', () => {
  it('counts UTC calendar days, not 24-hour spans', () => {
    expect(daysToPay('2026-03-01T23:59:00.000Z', '2026-03-02')).toBe(1);
    expect(daysToPay('2026-03-01T00:00:00.000Z', '2026-03-01')).toBe(0);
    expect(daysToPay('2026-02-27T12:00:00.000Z', '2026-03-03')).toBe(4);
  });
});

describe('formatMicros', () => {
  it('writes the integer exactly, with at least two decimals', () => {
    expect(formatMicros(0)).toBe('0.00');
    expect(formatMicros(5_000_000)).toBe('5.00');
    expect(formatMicros(12_345_600)).toBe('12.3456');
    expect(formatMicros(1)).toBe('0.000001');
    expect(formatMicros(9_007_199_254_740_991)).toBe('9007199254.740991');
  });

  it('refuses what is not an amount', () => {
    expect(() => formatMicros(-1)).toThrow(RangeError);
    expect(() => formatMicros(1.5)).toThrow(RangeError);
  });
});

describe('ledgerCsv', () => {
  it('writes a header and a row per payable, CRLF-terminated', () => {
    const csv = ledgerCsv([
      row({ status: 'paid', paidOn: '2026-03-04', totalMicros: 12_345_600 }),
    ]);
    expect(csv).toBe(
      'assignment,project,vendor,currency,words,total,complete,locked_on,status,paid_on\r\n' +
        '1,brochure,Ana,EUR,1000,12.3456,yes,2026-03-01,paid,2026-03-04\r\n',
    );
  });

  it('quotes a cell with a comma, a quote or a newline', () => {
    const csv = ledgerCsv([row({ project: 'a, "b"\nc' })]);
    expect(csv).toContain('"a, ""b""\nc"');
  });

  it('neutralises a cell a spreadsheet would run as a formula', () => {
    for (const start of ['=', '+', '-', '@', '\t']) {
      const csv = ledgerCsv([row({ vendorLabel: `${start}cmd` })]);
      const cell = csv.split('\r\n')[1]!.split(',')[2]!;
      expect(cell.replace(/^"/, '').startsWith("'")).toBe(true);
    }
  });

  it('writes an incomplete payable as such and a currency-less one with an empty currency', () => {
    const csv = ledgerCsv([row({ currency: null, totalMicros: 0, complete: false })]);
    expect(csv.split('\r\n')[1]).toBe('1,brochure,Ana,,1000,0.00,no,2026-03-01,unpaid,');
  });
});
