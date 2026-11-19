import { describe, expect, it } from 'vitest';

import { CURSOR_PAGE, isCursorKey, moveCursor, segmentToOpen } from './grid-entry.js';

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

describe('moveCursor', () => {
  it('puts a first press where the person is looking, whatever the arrow', () => {
    expect(moveCursor(20, null, 7, 'ArrowDown')).toBe(7);
    expect(moveCursor(20, null, 7, 'ArrowUp')).toBe(7);
    expect(moveCursor(20, null, 7, 'PageDown')).toBe(7);
  });

  it('moves one row at a time and stops at the ends', () => {
    expect(moveCursor(20, 7, 0, 'ArrowDown')).toBe(8);
    expect(moveCursor(20, 7, 0, 'ArrowUp')).toBe(6);
    expect(moveCursor(20, 19, 0, 'ArrowDown')).toBe(19);
    expect(moveCursor(20, 0, 0, 'ArrowUp')).toBe(0);
  });

  it('moves a page at a time and stops at the ends', () => {
    expect(moveCursor(40, 5, 0, 'PageDown')).toBe(5 + CURSOR_PAGE);
    expect(moveCursor(40, 25, 0, 'PageUp')).toBe(25 - CURSOR_PAGE);
    expect(moveCursor(40, 35, 0, 'PageDown')).toBe(39);
    expect(moveCursor(40, 3, 0, 'PageUp')).toBe(0);
  });

  it('goes to the ends with Home and End, with or without a cursor', () => {
    expect(moveCursor(20, 7, 3, 'Home')).toBe(0);
    expect(moveCursor(20, null, 3, 'End')).toBe(19);
  });

  it('clamps a start or a cursor the filter has left behind', () => {
    expect(moveCursor(5, null, 50, 'ArrowDown')).toBe(4);
    expect(moveCursor(5, null, -3, 'ArrowDown')).toBe(0);
    // The cursor sat on row 12 before a filter left five rows.
    expect(moveCursor(5, 12, 2, 'ArrowDown')).toBe(2);
  });

  it('has nowhere to go when nothing is shown', () => {
    expect(moveCursor(0, null, 0, 'ArrowDown')).toBeNull();
    expect(moveCursor(0, 3, 0, 'End')).toBeNull();
  });
});

describe('isCursorKey', () => {
  it('knows the six keys and nothing else', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End']) {
      expect(isCursorKey(key), key).toBe(true);
    }
    for (const key of ['Enter', 'ArrowLeft', 'a', ' ', 'Tab']) {
      expect(isCursorKey(key), key).toBe(false);
    }
  });
});
