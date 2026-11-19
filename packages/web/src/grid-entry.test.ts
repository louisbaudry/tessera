import { describe, expect, it } from 'vitest';

import { segmentToOpen } from './grid-entry.js';

const seg = (id: number, editable = true) => ({ id, editable });

describe('segmentToOpen', () => {
  const shown = [seg(10), seg(11, false), seg(12), seg(13)];

  it('opens the first editable segment in view', () => {
    expect(segmentToOpen(shown, null, 0)).toBe(0);
    expect(segmentToOpen(shown, null, 1)).toBe(2);
    expect(segmentToOpen(shown, null, 3)).toBe(3);
  });

  it('returns to the segment last left, wherever the view is', () => {
    expect(segmentToOpen(shown, 13, 0)).toBe(3);
    expect(segmentToOpen(shown, 10, 3)).toBe(0);
  });

  it('ignores a last-left segment that is filtered out or locked', () => {
    expect(segmentToOpen(shown, 99, 2)).toBe(2);
    expect(segmentToOpen(shown, 11, 0)).toBe(0);
  });

  it('looks backwards when nothing editable is at or after the view', () => {
    expect(segmentToOpen([seg(1), seg(2, false), seg(3, false)], null, 1)).toBe(0);
  });

  it('clamps a view index outside the list', () => {
    expect(segmentToOpen(shown, null, -5)).toBe(0);
    expect(segmentToOpen(shown, null, 50)).toBe(3);
  });

  it('opens nothing when no segment can be edited or none is shown', () => {
    expect(segmentToOpen([seg(1, false)], null, 0)).toBeNull();
    expect(segmentToOpen([], null, 0)).toBeNull();
    expect(segmentToOpen([], 1, 0)).toBeNull();
  });
});
