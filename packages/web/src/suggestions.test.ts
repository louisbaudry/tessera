import type { Segment, Token } from '@cat-tool/core';
import { describe, expect, it } from 'vitest';

import {
  createPrefetcher,
  GIVE_UP_AFTER,
  planPrefetch,
  PREFETCH_AHEAD,
  wantsDraft,
} from './suggestions.js';

let n = 0;
const seg = (over: Partial<Segment> = {}): Segment => ({
  id: ++n,
  fileId: 1,
  part: 'document',
  ord: n,
  paraKey: `p${n}`,
  paraOrd: 0,
  sourceTokens: [{ t: 'text', v: 'Hello' }],
  formatTable: [],
  targetTokens: null,
  sourceHash: `h${n}`,
  status: 'new',
  origin: null,
  locked: false,
  fallbackCopy: false,
  updatedAt: '2026-10-15T00:00:00.000Z',
  ...over,
});
const text = (v: string): Token[] => [{ t: 'text', v }];

describe('wantsDraft', () => {
  it('is an unlocked new segment with nothing visible in its target', () => {
    expect(wantsDraft(seg())).toBe(true);
    expect(wantsDraft(seg({ targetTokens: text('   ') }))).toBe(true);
    expect(wantsDraft(seg({ targetTokens: text('Hola') }))).toBe(false);
    expect(wantsDraft(seg({ status: 'draft' }))).toBe(false);
    expect(wantsDraft(seg({ status: 'confirmed' }))).toBe(false);
    expect(wantsDraft(seg({ locked: true }))).toBe(false);
  });
});

describe('planPrefetch', () => {
  const shown = Array.from({ length: 8 }, () => seg());
  const ids = shown.map((s) => s.id);

  it('plans the open segment and the next few, in the order shown', () => {
    expect(planPrefetch(shown, ids[2]!, new Set())).toEqual(
      ids.slice(2, 2 + PREFETCH_AHEAD + 1),
    );
  });

  it('plans nothing with no open segment, or one that is not shown', () => {
    expect(planPrefetch(shown, null, new Set())).toEqual([]);
    expect(planPrefetch(shown, 99999, new Set())).toEqual([]);
  });

  it('skips what cannot take a draft and what was already settled, reaching further for the rest', () => {
    const mixed = [
      seg(),
      seg({ locked: true }),
      seg({ targetTokens: text('Hola') }),
      seg(),
      seg(),
      seg(),
      seg(),
    ];
    const settled = new Set([mixed[3]!.id]);
    expect(planPrefetch(mixed, mixed[0]!.id, settled, 2)).toEqual([
      mixed[0]!.id,
      mixed[4]!.id,
      mixed[5]!.id,
    ]);
  });

  it('never looks behind the open segment', () => {
    expect(planPrefetch(shown, ids[7]!, new Set())).toEqual([ids[7]]);
  });
});

/** An ask that records its order and lets the test answer each call. */
function harness(answer: (id: number) => Token[] | null | Error) {
  const asked: number[] = [];
  const got: Array<[number, Token[]]> = [];
  let inFlight = 0;
  let peak = 0;
  const prefetcher = createPrefetcher({
    ask: async (id) => {
      asked.push(id);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight--;
      const a = answer(id);
      if (a instanceof Error) throw a;
      return a;
    },
    onSuggestion: (id, tokens) => got.push([id, [...tokens]]),
  });
  return { prefetcher, asked, got, peak: () => peak };
}

describe('createPrefetcher', () => {
  it('asks one at a time, in the order wanted, and reports each draft that arrives', async () => {
    const h = harness((id) => text(`d${id}`));
    h.prefetcher.want([1, 2, 3]);
    await h.prefetcher.whenIdle();
    expect(h.asked).toEqual([1, 2, 3]);
    expect(h.peak()).toBe(1);
    expect(h.got.map(([id]) => id)).toEqual([1, 2, 3]);
  });

  it('asks nothing twice, however often the cursor comes back', async () => {
    const h = harness((id) => text(`d${id}`));
    h.prefetcher.want([1, 2]);
    await h.prefetcher.whenIdle();
    h.prefetcher.want([2, 1, 3]);
    await h.prefetcher.whenIdle();
    expect(h.asked).toEqual([1, 2, 3]);
  });

  it('puts the newest wish first when the cursor moves, but never abandons a request in flight', async () => {
    const h = harness((id) => text(`d${id}`));
    h.prefetcher.want([1, 2, 3]); // 1 starts at once
    h.prefetcher.want([9, 8]); // the cursor moved: 2 and 3 are no longer wanted
    await h.prefetcher.whenIdle();
    expect(h.asked).toEqual([1, 9, 8]);
  });

  it('does not ask for a segment that already has a draft', async () => {
    const h = harness((id) => text(`d${id}`));
    h.prefetcher.have(2);
    h.prefetcher.want([1, 2, 3]);
    await h.prefetcher.whenIdle();
    expect(h.asked).toEqual([1, 3]);
  });

  it('gives up after a few empty answers in a row, and stays quiet until reloaded', async () => {
    const h = harness(() => null);
    h.prefetcher.want([1, 2, 3, 4, 5, 6]);
    await h.prefetcher.whenIdle();
    expect(h.asked).toHaveLength(GIVE_UP_AFTER);
    h.prefetcher.want([7, 8]);
    await h.prefetcher.whenIdle();
    expect(h.asked).toHaveLength(GIVE_UP_AFTER);
    expect(h.got).toEqual([]);
  });

  it('counts a failed request as empty, never as an error anyone sees', async () => {
    const h = harness(() => new Error('network'));
    h.prefetcher.want([1, 2, 3, 4]);
    await h.prefetcher.whenIdle();
    expect(h.asked).toHaveLength(GIVE_UP_AFTER);
  });

  it('keeps going while drafts arrive: a draft resets the count of empty answers', async () => {
    const h = harness((id) => (id % 3 === 0 ? text('d') : null));
    h.prefetcher.want([1, 2, 3, 4, 5, 6, 7]);
    await h.prefetcher.whenIdle();
    expect(h.asked).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
