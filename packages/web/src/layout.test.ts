import { describe, expect, it } from 'vitest';

import { CHARS_PER_LINE, estimateRowHeight, LINE_HEIGHT, ROW_PADDING } from './layout.js';

describe('estimateRowHeight', () => {
  it('is one line for a short or empty segment', () => {
    expect(estimateRowHeight([], null)).toBe(ROW_PADDING + LINE_HEIGHT);
    expect(estimateRowHeight([{ t: 'text', v: 'Hi.' }], null)).toBe(
      ROW_PADDING + LINE_HEIGHT,
    );
  });

  it('grows with the longer side', () => {
    const long = [{ t: 'text' as const, v: 'x'.repeat(CHARS_PER_LINE * 3) }];
    expect(estimateRowHeight([{ t: 'text', v: 'short' }], long)).toBe(
      ROW_PADDING + 3 * LINE_HEIGHT,
    );
    expect(estimateRowHeight(long, null)).toBe(ROW_PADDING + 3 * LINE_HEIGHT);
  });
});
