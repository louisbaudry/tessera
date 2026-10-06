/** Segment model. See planning/v1-spec.md §4.1. */

import type { FormatEntry, Token } from './token.js';

export const SEGMENT_STATUSES = [
  /** Extracted, never touched. */
  'new',
  /** Has a target, but not accepted — e.g. a fuzzy or tag-mismatched TM hit. */
  'draft',
  /** Translated but not yet confirmed. */
  'translated',
  /** Confirmed by the translator; written back to the TM. */
  'confirmed',
  /** Not editable — untranslatable content, or locked by the user. */
  'locked',
] as const;
export type SegmentStatus = (typeof SEGMENT_STATUSES)[number];

/**
 * Where a target came from.
 *
 * Deliberately a widened string rather than a closed union: adding
 * `tm_fuzzy_85` or `tm_ice` later must not require a schema migration
 * (planning/v1-spec.md §4.3). `tm_fuzzy_<score>` is now written
 * (`fuzzyOrigin`).
 */
export const KNOWN_ORIGINS = ['tm_exact', 'tm_exact_tagdiff', 'propagated'] as const;
export type KnownOrigin = (typeof KNOWN_ORIGINS)[number];
export type Origin = KnownOrigin | (string & {});

/**
 * The `origin` a placed fuzzy match carries: its score, not its band
 * (`v1-spec.md` §6.1a, 3), so a revision of the bands needs no migration.
 * Not in {@link KNOWN_ORIGINS}, which is a closed list of literals.
 */
export function fuzzyOrigin(score: number): string {
  return `tm_fuzzy_${score}`;
}

/** The score in a fuzzy `origin`, or `null` when it is any other origin. */
export function fuzzyScoreOfOrigin(origin: string | null): number | null {
  const m = /^tm_fuzzy_(\d{1,3})$/.exec(origin ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * Which XML part a segment was extracted from.
 *
 * Skeletons are per part, not per document: footnote and endnote bodies
 * are translatable (planning/v1-spec.md §3.5), and a real manuscript can
 * carry ten or more footers. Export splices each target back into the
 * skeleton of the part it came from.
 */
export type DocPart =
  'document' | 'footnotes' | 'endnotes' | `header${number}` | `footer${number}`;

export interface Segment {
  readonly id: number;
  readonly fileId: number;
  readonly part: DocPart;
  /** Position in document order, within the whole file. */
  readonly ord: number;
  /** Marker id in that part's skeleton. */
  readonly paraKey: string;
  /** Nth segment within its paragraph. */
  readonly paraOrd: number;
  readonly sourceTokens: readonly Token[];
  /**
   * This segment's own format table — `sourceTokens`/`targetTokens.fmt`
   * indexes into it. Per segment, not per file (`v1-spec.md` §4.1's
   * 2026-08-30 correction): `segmentTokens` already gives each
   * sentence-level split its own renumbered table, so that is the
   * natural, self-contained shape to store rather than inventing a
   * file-wide one.
   */
  readonly formatTable: readonly FormatEntry[];
  readonly targetTokens: readonly Token[] | null;
  /** Normalised SHA-256 of the source. See planning/tm-format-spec.md §4. */
  readonly sourceHash: string;
  readonly status: SegmentStatus;
  readonly origin: Origin | null;
  readonly locked: boolean;
  /**
   * Inside an `mc:Fallback`: the VML copy of a text box whose DrawingML
   * copy is another segment (v1-spec.md §3.6). Translated and rendered
   * like any other, counted once — as its twin (backlog #34).
   */
  readonly fallbackCopy: boolean;
  readonly updatedAt: string;
}

/** A segment counts toward progress only once confirmed. */
export function isConfirmed(segment: Segment): boolean {
  return segment.status === 'confirmed';
}

/** Pre-translate must never overwrite these. See planning/v1-spec.md §6.1. */
export function isProtectedFromPretranslate(segment: Segment): boolean {
  return segment.locked || segment.status === 'confirmed' || segment.status === 'locked';
}
