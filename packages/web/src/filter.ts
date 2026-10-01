/**
 * The grid's filter bar and progress line (v1-spec.md §7; backlog #34).
 * Pure, so what a filter shows and what progress counts are provable in
 * node; `Grid.tsx` only renders them.
 */
import type { Origin, Segment, SegmentStatus } from '@cat-tool/core';
import { hasSpacedWords, plainText, segmentWords } from '@cat-tool/core/model';

import { statusOf, type QaMark } from './gutter.js';

/** Which QA state a segment must be in to show. */
export type QaFilter = 'any' | 'flagged' | 'errors' | 'clean';

export interface SegmentFilter {
  /** Matched case-insensitively against the source and the target text. */
  readonly text: string;
  /** The statuses shown (a locked segment's is `locked`); all when empty. */
  readonly statuses: ReadonlySet<SegmentStatus>;
  /**
   * One origin, `''` for "no origin" (typed by hand, or untouched), or
   * `null` for every origin. A value, not a member of a closed list:
   * origin is an open string (§4.3), and a value this screen has never
   * heard of is offered like any other.
   */
  readonly origin: Origin | '' | null;
  readonly qa: QaFilter;
}

export const NO_FILTER: SegmentFilter = {
  text: '',
  statuses: new Set(),
  origin: null,
  qa: 'any',
};

export function isFiltering(filter: SegmentFilter): boolean {
  return (
    filter.text.trim() !== '' ||
    filter.statuses.size > 0 ||
    filter.origin !== null ||
    filter.qa !== 'any'
  );
}

/**
 * Whether `segment` passes `filter`. `mark` is its gutter mark — the
 * worst *undismissed* severity — so a segment whose findings are all
 * dismissed is clean, as the gutter shows it.
 */
export function matches(
  segment: Segment,
  mark: QaMark | undefined,
  filter: SegmentFilter,
): boolean {
  if (filter.statuses.size > 0 && !filter.statuses.has(statusOf(segment))) return false;
  if (filter.origin !== null && (segment.origin ?? '') !== filter.origin) return false;
  if (filter.qa === 'flagged' && !mark) return false;
  if (filter.qa === 'errors' && mark?.severity !== 'error') return false;
  if (filter.qa === 'clean' && mark) return false;
  const needle = filter.text.trim().toLocaleLowerCase();
  if (needle === '') return true;
  return (
    plainText(segment.sourceTokens).toLocaleLowerCase().includes(needle) ||
    (segment.targetTokens !== null &&
      plainText(segment.targetTokens).toLocaleLowerCase().includes(needle))
  );
}

/**
 * The segments the grid shows: those `filter` passes, in document order —
 * and the one open in the editor whatever the filter says, so an edit that
 * takes it out of the filter (a `new` segment, translated) does not pull
 * it from under the caret.
 */
export function visibleSegments(
  segments: readonly Segment[],
  marks: ReadonlyMap<number, QaMark>,
  filter: SegmentFilter,
  openId: number | null,
): readonly Segment[] {
  if (!isFiltering(filter)) return segments;
  return segments.filter((s) => s.id === openId || matches(s, marks.get(s.id), filter));
}

/** The origins in the file, `''` for none, each with how many segments. */
export function originCounts(segments: readonly Segment[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const s of segments) {
    const origin = s.origin ?? '';
    counts.set(origin, (counts.get(origin) ?? 0) + 1);
  }
  return new Map([...counts].sort(([a], [b]) => a.localeCompare(b)));
}

export interface Progress {
  readonly segments: { readonly confirmed: number; readonly total: number };
  /** Null when the source language does not space its words (§3.6). */
  readonly words: { readonly confirmed: number; readonly total: number } | null;
}

/**
 * Segments and words confirmed, of those there are to translate. A locked
 * segment is neither: it is never translated (§3.5) and has no words. A
 * text box's `mc:Fallback` copy is a segment to confirm — it is rendered
 * too — but its words are its twin's (`segmentWords`). Words are `core`'s
 * one definition (§3.6), as the portal's estimate and vendor pay count.
 */
export function progress(segments: readonly Segment[], srcLang: string): Progress {
  const counted = hasSpacedWords(srcLang);
  let confirmed = 0;
  let total = 0;
  let wordsConfirmed = 0;
  let wordsTotal = 0;
  for (const s of segments) {
    const status = statusOf(s);
    if (status === 'locked') continue;
    total++;
    const words = counted ? segmentWords(s) : 0;
    wordsTotal += words;
    if (status === 'confirmed') {
      confirmed++;
      wordsConfirmed += words;
    }
  }
  return {
    segments: { confirmed, total },
    words: counted ? { confirmed: wordsConfirmed, total: wordsTotal } : null,
  };
}
