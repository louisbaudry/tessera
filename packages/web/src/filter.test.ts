import type { Segment } from '@cat-tool/core';
import { describe, expect, it } from 'vitest';

import {
  isFiltering,
  matches,
  NO_FILTER,
  originCounts,
  progress,
  visibleSegments,
  type SegmentFilter,
} from './filter.js';
import type { QaMark } from './gutter.js';

let nextId = 1;
const seg = (over: Partial<Segment> = {}): Segment => ({
  id: nextId++,
  fileId: 1,
  part: 'document',
  ord: 0,
  paraKey: 's1',
  paraOrd: 0,
  sourceTokens: [{ t: 'text', v: 'Hello brave world' }],
  formatTable: [],
  targetTokens: null,
  sourceHash: 'h',
  status: 'new',
  origin: null,
  locked: false,
  fallbackCopy: false,
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});
const f = (over: Partial<SegmentFilter>): SegmentFilter => ({ ...NO_FILTER, ...over });
const error: QaMark = { severity: 'error', count: 1, messages: [] };
const warning: QaMark = { severity: 'warning', count: 1, messages: [] };

describe('matches', () => {
  it('searches source and target text, case-insensitively', () => {
    const s = seg({ targetTokens: [{ t: 'text', v: 'Hallo mutige Welt' }] });
    expect(matches(s, undefined, f({ text: 'BRAVE' }))).toBe(true);
    expect(matches(s, undefined, f({ text: ' mutige ' }))).toBe(true);
    expect(matches(s, undefined, f({ text: 'nowhere' }))).toBe(false);
  });

  it('filters by status, a locked segment reading as locked', () => {
    const draft = seg({ status: 'draft' });
    const locked = seg({ status: 'new', locked: true });
    const only = f({ statuses: new Set(['draft', 'locked']) });
    expect(matches(draft, undefined, only)).toBe(true);
    expect(matches(locked, undefined, only)).toBe(true);
    expect(matches(seg(), undefined, only)).toBe(false);
  });

  it('filters by origin, a value it has never heard of included, or by none', () => {
    const fuzzy = seg({ origin: 'tm_fuzzy_85' });
    expect(matches(fuzzy, undefined, f({ origin: 'tm_fuzzy_85' }))).toBe(true);
    expect(matches(fuzzy, undefined, f({ origin: 'tm_exact' }))).toBe(false);
    expect(matches(seg(), undefined, f({ origin: '' }))).toBe(true);
    expect(matches(fuzzy, undefined, f({ origin: '' }))).toBe(false);
  });

  it('filters by QA state, as the gutter shows it', () => {
    expect(matches(seg(), warning, f({ qa: 'flagged' }))).toBe(true);
    expect(matches(seg(), warning, f({ qa: 'errors' }))).toBe(false);
    expect(matches(seg(), error, f({ qa: 'errors' }))).toBe(true);
    expect(matches(seg(), undefined, f({ qa: 'clean' }))).toBe(true);
    expect(matches(seg(), warning, f({ qa: 'clean' }))).toBe(false);
  });
});

describe('visibleSegments', () => {
  it('keeps the open segment whatever the filter says', () => {
    const a = seg({ status: 'new' });
    const b = seg({ status: 'translated' });
    const c = seg({ status: 'new' });
    const onlyNew = f({ statuses: new Set(['new']) });
    expect(visibleSegments([a, b, c], new Map(), onlyNew, null)).toEqual([a, c]);
    expect(visibleSegments([a, b, c], new Map(), onlyNew, b.id)).toEqual([a, b, c]);
  });

  it('is the list itself when nothing filters', () => {
    const all = [seg(), seg()];
    expect(isFiltering(f({ text: '  ' }))).toBe(false);
    expect(visibleSegments(all, new Map(), NO_FILTER, null)).toBe(all);
  });
});

describe('originCounts', () => {
  it('counts each origin, none as the empty string', () => {
    const counts = originCounts([
      seg({ origin: 'tm_exact' }),
      seg(),
      seg({ origin: 'tm_exact' }),
      seg({ origin: 'tm_fuzzy_85' }),
    ]);
    expect([...counts]).toEqual([
      ['', 1],
      ['tm_exact', 2],
      ['tm_fuzzy_85', 1],
    ]);
  });
});

describe('progress', () => {
  const words = (v: string) => [{ t: 'text' as const, v }];

  it('counts confirmed segments and words, leaving locked ones and fallback words out', () => {
    const p = progress(
      [
        seg({ status: 'confirmed', sourceTokens: words('one two three') }),
        seg({ status: 'translated', sourceTokens: words('four five') }),
        seg({ locked: true, sourceTokens: words('2024') }),
        // A text box's second copy: a segment to confirm, its words its twin's.
        seg({ status: 'confirmed', fallbackCopy: true, sourceTokens: words('six') }),
      ],
      'en-US',
    );
    expect(p).toEqual({
      segments: { confirmed: 2, total: 3 },
      words: { confirmed: 3, total: 5 },
    });
  });

  it('has no word count for a language that does not space its words', () => {
    const p = progress([seg({ status: 'confirmed' })], 'ja');
    expect(p).toEqual({ segments: { confirmed: 1, total: 1 }, words: null });
  });
});
