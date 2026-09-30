import { describe, expect, it } from 'vitest';

import { splitOffset, type SourceChild } from './split-point.js';

const text = (length: number): SourceChild => ({ kind: 'text', length });
const chip: SourceChild = { kind: 'chip' };

describe('splitOffset', () => {
  // "Hello " ‹1 world ›1 !  → text 6, chip, text 5, chip, text 1
  const children = [text(6), chip, text(5), chip, text(1)];

  it('counts characters inside the child the caret is in', () => {
    expect(splitOffset(children, 0, 3)).toBe(3);
    expect(splitOffset(children, 2, 2)).toBe(8);
  });

  it('counts no characters for a chip, before it or on it', () => {
    expect(splitOffset(children, 1, 0)).toBe(6);
    expect(splitOffset(children, 1, 1)).toBe(6);
    expect(splitOffset(children, 3, 0)).toBe(11);
  });

  it('puts a caret past the last child at the end of the text', () => {
    expect(splitOffset(children, 5, 0)).toBe(12);
    expect(splitOffset(children, 99, 0)).toBe(12);
  });

  it('keeps a caret inside its child, whatever the DOM reports', () => {
    expect(splitOffset(children, 0, 999)).toBe(6);
    expect(splitOffset(children, 0, -4)).toBe(0);
    expect(splitOffset([], 0, 0)).toBe(0);
  });
});
