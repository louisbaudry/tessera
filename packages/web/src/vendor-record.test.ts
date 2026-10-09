import type { VendorRecord } from '@cat-tool/vendor-core';
import { describe, expect, it } from 'vitest';

import { acceptanceLabel, onTimeLabel } from './vendor-record.js';

const record = (over: Partial<VendorRecord> = {}): VendorRecord => ({
  answered: 0,
  accepted: 0,
  timed: 0,
  onTime: 0,
  delivered: 0,
  ...over,
});

describe('acceptanceLabel', () => {
  it('says nothing has been answered rather than showing 0 of 0 or a rate', () => {
    expect(acceptanceLabel(record())).toBe('No offer answered yet');
  });

  it('always gives the count with the number it is out of', () => {
    expect(acceptanceLabel(record({ answered: 5, accepted: 4 }))).toBe(
      'Accepted 4 of 5 offers answered',
    );
    expect(acceptanceLabel(record({ answered: 1, accepted: 0 }))).toBe(
      'Accepted 0 of 1 offer answered',
    );
  });

  it('never prints a percentage', () => {
    expect(acceptanceLabel(record({ answered: 3, accepted: 2 }))).not.toContain('%');
  });
});

describe('onTimeLabel', () => {
  it('says nothing was delivered yet when that is so', () => {
    expect(onTimeLabel(record())).toBe('Nothing delivered yet');
  });

  it('says when the deliveries had no deadline, so nothing can be on time', () => {
    expect(onTimeLabel(record({ delivered: 2 }))).toBe(
      '2 deliveries, none with a deadline',
    );
    expect(onTimeLabel(record({ delivered: 1 }))).toBe(
      '1 delivery, none with a deadline',
    );
  });

  it('reads on time against the deliveries that had a deadline', () => {
    expect(onTimeLabel(record({ delivered: 4, timed: 4, onTime: 3 }))).toBe(
      'On time 3 of 4 deliveries with a deadline',
    );
  });

  it('names the deliveries left out of the sample', () => {
    expect(onTimeLabel(record({ delivered: 5, timed: 4, onTime: 4 }))).toBe(
      'On time 4 of 4 deliveries with a deadline (1 without one)',
    );
  });
});
