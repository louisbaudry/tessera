import { describe, expect, it } from 'vitest';

import { countWords, estimateWordCount } from './word-count.js';

describe('countWords', () => {
  it('counts whitespace-separated words', () => {
    expect(countWords('hello world')).toBe(2);
  });

  it('collapses repeated whitespace', () => {
    expect(countWords('hello   world\n\nfoo')).toBe(3);
  });

  it('is zero for an empty or whitespace-only string', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   \n\t ')).toBe(0);
  });
});

describe('estimateWordCount', () => {
  it('counts plain text exactly', () => {
    expect(estimateWordCount('text/plain', 'one two three')).toBe(3);
  });

  it('returns null for a content type it cannot estimate', () => {
    expect(
      estimateWordCount(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'irrelevant',
      ),
    ).toBeNull();
  });

  it('returns null when there is no text to count', () => {
    expect(estimateWordCount('text/plain', null)).toBeNull();
  });
});
