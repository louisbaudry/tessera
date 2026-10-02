/** Test scaffolding for `core/glossary`: a `Segment` from a sentence. Not exported from the package. */
import type { Segment } from '../model/segment.js';

export function seg(
  ord: number,
  source: string,
  over: Partial<Segment> & { target?: string } = {},
): Segment {
  const { target, ...rest } = over;
  return {
    id: ord + 1,
    fileId: 1,
    part: 'document',
    ord,
    paraKey: `p${ord}`,
    paraOrd: 0,
    sourceTokens: [{ t: 'text', v: source }],
    formatTable: [],
    targetTokens: target === undefined ? null : [{ t: 'text', v: target }],
    sourceHash: '',
    status: 'new',
    origin: null,
    locked: false,
    fallbackCopy: false,
    updatedAt: '2026-10-02T00:00:00.000Z',
    ...rest,
  };
}

/** `n` copies of a sentence as consecutive segments from `from`. */
export function repeat(from: number, n: number, source: string): Segment[] {
  return Array.from({ length: n }, (_, i) => seg(from + i, source));
}
