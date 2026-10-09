import { describe, expect, it } from 'vitest';

import { vendorRecord, type RecordRow } from './record.js';

const row = (over: Partial<RecordRow> = {}): RecordRow => ({
  status: 'offered',
  deadline: null,
  deliveredAt: null,
  ...over,
});

describe('vendorRecord', () => {
  it('is all zeros for a vendor with no jobs, so no rate can be read from it', () => {
    expect(vendorRecord([])).toEqual({
      answered: 0,
      accepted: 0,
      timed: 0,
      onTime: 0,
      delivered: 0,
    });
  });

  it('counts an offer as answered only once accepted or declined', () => {
    const r = vendorRecord([
      row({ status: 'offered' }),
      row({ status: 'claimed' }),
      row({ status: 'accepted' }),
      row({ status: 'declined' }),
    ]);
    expect(r.answered).toBe(2);
    expect(r.accepted).toBe(1);
  });

  it('counts every status past the acceptance as an acceptance', () => {
    const r = vendorRecord(
      (['accepted', 'in_progress', 'delivered', 'reviewed'] as const).map((status) =>
        row({ status }),
      ),
    );
    expect(r.accepted).toBe(4);
    expect(r.answered).toBe(4);
  });

  it('takes a job delivered at the deadline as on time, one a moment after as late', () => {
    const deadline = '2026-03-10T12:00:00.000Z';
    const r = vendorRecord([
      row({ status: 'delivered', deadline, deliveredAt: '2026-03-10T12:00:00.000Z' }),
      row({ status: 'reviewed', deadline, deliveredAt: '2026-03-09T08:00:00.000Z' }),
      row({ status: 'delivered', deadline, deliveredAt: '2026-03-10T12:00:00.001Z' }),
    ]);
    expect(r.timed).toBe(3);
    expect(r.onTime).toBe(2);
  });

  it('compares instants, not text: an offset deadline is read as the time it names', () => {
    const r = vendorRecord([
      row({
        status: 'delivered',
        deadline: '2026-03-10T12:00:00+02:00',
        deliveredAt: '2026-03-10T09:30:00.000Z',
      }),
    ]);
    expect(r.onTime).toBe(1);
    const late = vendorRecord([
      row({
        status: 'delivered',
        deadline: '2026-03-10T12:00:00+02:00',
        deliveredAt: '2026-03-10T10:30:00.000Z',
      }),
    ]);
    expect(late.onTime).toBe(0);
    expect(late.timed).toBe(1);
  });

  it('leaves a job with no deadline out of the on-time sample but still counts it delivered', () => {
    const r = vendorRecord([
      row({
        status: 'delivered',
        deadline: null,
        deliveredAt: '2026-03-10T09:00:00.000Z',
      }),
    ]);
    expect(r.delivered).toBe(1);
    expect(r.timed).toBe(0);
    expect(r.onTime).toBe(0);
  });

  it('does not count an in-progress job against the deadline', () => {
    const r = vendorRecord([
      row({ status: 'in_progress', deadline: '2020-01-01T00:00:00Z' }),
    ]);
    expect(r.timed).toBe(0);
    expect(r.delivered).toBe(0);
  });
});
