import type { SegmentStatus } from '@cat-tool/core';
import { describe, expect, it } from 'vitest';

import { nextUnconfirmed } from './advance.js';

const seg = (status: SegmentStatus, locked = false) => ({ status, locked });

describe('nextUnconfirmed', () => {
  it('skips confirmed and locked segments, whichever way a lock is recorded', () => {
    const all = [
      seg('translated'),
      seg('confirmed'),
      seg('locked'),
      seg('draft', true),
      seg('new'),
    ];
    expect(nextUnconfirmed(all, 0)).toBe(4);
  });

  it('takes a translated or draft segment: they are not confirmed', () => {
    expect(nextUnconfirmed([seg('confirmed'), seg('draft')], 0)).toBe(1);
    expect(nextUnconfirmed([seg('confirmed'), seg('translated')], 0)).toBe(1);
  });

  it('goes forward only and never wraps: nothing left below is null', () => {
    const all = [seg('new'), seg('confirmed'), seg('confirmed')];
    expect(nextUnconfirmed(all, 1)).toBeNull();
    expect(nextUnconfirmed(all, 2)).toBeNull();
  });
});
