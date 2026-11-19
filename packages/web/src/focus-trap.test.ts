import { describe, expect, it } from 'vitest';

import { keepFocusInside, wrapIndex } from './focus-trap.js';

describe('wrapIndex', () => {
  it('lets the browser move focus while the move stays inside', () => {
    expect(wrapIndex(3, 0, false)).toBeNull();
    expect(wrapIndex(3, 1, false)).toBeNull();
    expect(wrapIndex(3, 1, true)).toBeNull();
    expect(wrapIndex(3, 2, true)).toBeNull();
  });

  it('wraps Tab from the last element to the first, and Shift+Tab the other way', () => {
    expect(wrapIndex(3, 2, false)).toBe(0);
    expect(wrapIndex(3, 0, true)).toBe(2);
  });

  it('keeps a dialog with one element on that element', () => {
    expect(wrapIndex(1, 0, false)).toBe(0);
    expect(wrapIndex(1, 0, true)).toBe(0);
  });

  it('brings focus in when it is somewhere else', () => {
    expect(wrapIndex(3, -1, false)).toBe(0);
    expect(wrapIndex(3, -1, true)).toBe(2);
  });

  it('swallows the key when nothing can take focus', () => {
    expect(wrapIndex(0, -1, false)).toBe(-1);
  });
});

describe('keepFocusInside', () => {
  it('ignores every key but Tab, without looking at the dialog', () => {
    let prevented = false;
    const event = {
      key: 'Escape',
      shiftKey: false,
      preventDefault: () => {
        prevented = true;
      },
    };
    // A dialog that throws if touched: any other key must return before reading it.
    const dialog = new Proxy({} as HTMLElement, {
      get: () => {
        throw new Error('the dialog was read');
      },
    });
    keepFocusInside(event, dialog);
    expect(prevented).toBe(false);
  });
});
