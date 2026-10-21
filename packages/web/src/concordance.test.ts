import { describe, expect, it } from 'vitest';

import {
  isConcordanceKey,
  MAX_QUERY_CHARS,
  pieces,
  startFromSelection,
  summary,
  type ConcordanceView,
} from './concordance.js';

describe('startFromSelection', () => {
  it('looks a selection up on the side it was selected in', () => {
    expect(startFromSelection({ side: 'target', text: ' Drücken\n Sie ' })).toEqual({
      side: 'target',
      text: 'Drücken Sie',
    });
    expect(startFromSelection({ side: 'source', text: 'press' })).toEqual({
      side: 'source',
      text: 'press',
    });
  });

  it('opens an empty source box without a selection, with a blank one, or with a sentence', () => {
    const empty = { side: 'source', text: '' };
    expect(startFromSelection(null)).toEqual(empty);
    expect(startFromSelection({ side: 'target', text: '  \n ' })).toEqual(empty);
    expect(
      startFromSelection({ side: 'target', text: 'a'.repeat(MAX_QUERY_CHARS + 1) }),
    ).toEqual(empty);
  });
});

describe('pieces', () => {
  it('cuts the text around the ranges and loses none of it', () => {
    const text = 'How to set up a network, set up';
    const out = pieces(text, [
      { start: 7, end: 13 },
      { start: 25, end: 31 },
    ]);
    expect(out.map((p) => [p.text, p.hit])).toEqual([
      ['How to ', false],
      ['set up', true],
      [' a network, ', false],
      ['set up', true],
    ]);
    expect(out.map((p) => p.text).join('')).toBe(text);
  });

  it('is the whole text, unmarked, without ranges', () => {
    expect(pieces('plain', [])).toEqual([{ text: 'plain', hit: false }]);
    expect(pieces('', [])).toEqual([]);
  });

  it('survives ranges that are out of order, overlapping or past the end', () => {
    const text = 'abcdef';
    const out = pieces(text, [
      { start: 3, end: 5 },
      { start: 1, end: 4 },
      { start: 5, end: 99 },
      { start: 9, end: 12 },
    ]);
    expect(out.map((p) => p.text).join('')).toBe(text);
    expect(out.filter((p) => p.hit).map((p) => p.text)).toEqual(['de', 'f']);
  });
});

describe('summary', () => {
  const view = (hits: number, more = false, searched = 1): ConcordanceView => ({
    hits: Array.from({ length: hits }, (_, i) => ({
      tuId: i,
      memory: 1,
      source: '',
      target: '',
      ranges: [],
      updatedAt: '',
    })),
    more,
    searched,
  });

  it('says what was found, and that there is more', () => {
    expect(summary(view(0))).toBe('No match.');
    expect(summary(view(1))).toBe('1 match, newest first.');
    expect(summary(view(2))).toBe('2 matches, newest first.');
    expect(summary(view(50, true))).toBe(
      '50 matches shown, newest first. There are more.',
    );
  });

  it('says plainly when no memory is attached, which is not the same as no match', () => {
    expect(summary(view(0, false, 0))).toBe('No memory is attached to this project.');
  });
});

describe('isConcordanceKey', () => {
  const key = {
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: true,
    code: 'KeyL',
  };
  it('is Ctrl+Shift+L and nothing else', () => {
    expect(isConcordanceKey(key)).toBe(true);
    expect(isConcordanceKey({ ...key, shiftKey: false })).toBe(false);
    expect(isConcordanceKey({ ...key, ctrlKey: false })).toBe(false);
    expect(isConcordanceKey({ ...key, metaKey: true })).toBe(false);
    expect(isConcordanceKey({ ...key, altKey: true })).toBe(false);
    expect(isConcordanceKey({ ...key, code: 'KeyD' })).toBe(false);
  });
});
