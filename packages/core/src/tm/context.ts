import type { Segment } from '../model/segment.js';
import { plainText } from '../model/token.js';
import { hashOf } from './normalize.js';

/**
 * Context capture (tm-format-spec.md §5; backlog #17a, #20).
 *
 * `prev_hash`/`next_hash` on a `.ctm` variant hold the hash of the
 * neighbouring segments *in that same language*, from the document the
 * variant came from — the one thing that must be captured at write
 * time, since the source document is gone afterward. This module is
 * that capture: given a document's segments in order, it returns each
 * translatable one's neighbour hashes, ready to be handed to whatever
 * writes the `tuv` row (pre-translate reads only, #19; confirm writes,
 * #20).
 *
 * Deliberately pure and SQLite-free, like `mapping.ts` and
 * `normalize.ts` beside it: the caller decides which hash (source
 * today; a target hash once one exists) each entry carries.
 */

/** The minimum a segment needs to supply to take part in a context chain. */
export interface ContextEntry {
  readonly id: number;
  /** Position in document order (`Segment.ord`). */
  readonly ord: number;
  readonly hash: string;
  readonly locked: boolean;
}

export interface SegmentContext {
  readonly prevHash: string | null;
  readonly nextHash: string | null;
}

/**
 * Neighbour hashes for every translatable entry, keyed by `id`.
 *
 * Locked entries are skipped entirely — both as neighbours (a
 * page-break marker or empty table cell between two sentences is not
 * part of either one's surrounding context) and as keys in the result
 * (a locked segment is never confirmed, so it never becomes a `tuv`
 * and never needs context of its own). A translatable entry with no
 * translatable neighbour on one side gets `null` there, exactly as at
 * a real document boundary (tm-format-spec.md §5).
 *
 * Sorts by `ord` internally, so callers may pass entries in any order.
 */
export function documentContext(
  entries: readonly ContextEntry[],
): ReadonlyMap<number, SegmentContext> {
  const translatable = entries
    .filter((e) => !e.locked)
    .slice()
    .sort((a, b) => a.ord - b.ord);

  const result = new Map<number, SegmentContext>();
  translatable.forEach((entry, i) => {
    result.set(entry.id, {
      prevHash: i > 0 ? translatable[i - 1]!.hash : null,
      nextHash: i < translatable.length - 1 ? translatable[i + 1]!.hash : null,
    });
  });
  return result;
}

/**
 * {@link documentContext} for the one hash a project actually stores
 * today — `sourceHash`. Every non-locked segment takes part regardless
 * of translation status: the source text is fixed from import, so its
 * context is knowable immediately.
 */
export function sourceDocumentContext(
  segments: readonly Segment[],
): ReadonlyMap<number, SegmentContext> {
  return documentContext(
    segments.map((s) => ({ id: s.id, ord: s.ord, hash: s.sourceHash, locked: s.locked })),
  );
}

/**
 * {@link documentContext} for the *confirmed* target language — the
 * counterpart {@link sourceDocumentContext} promised once target-side
 * hashing existed (write-back, #20).
 *
 * Only already-`confirmed` segments take part, plus `confirmingId`
 * itself (the segment about to become confirmed — its `targetTokens`
 * are already present, just not yet marked confirmed by the caller).
 * An unconfirmed neighbour's target is provisional, so it is not part
 * of the surrounding context yet — matching the general rule that
 * context is captured once, at write time, and never retroactively
 * revised: a sibling confirmed *after* this one does not reach back and
 * patch this write's `next_hash`/`prev_hash` (`tm-format-spec.md` §5's
 * "context not recorded at write time is unrecoverable" cuts both
 * ways — recomputing it later is a different, larger feature, not this
 * one).
 */
export function confirmedTargetContext(
  segments: readonly Segment[],
  confirmingId: number,
): ReadonlyMap<number, SegmentContext> {
  const entries = segments
    .filter((s) => s.targetTokens && (s.status === 'confirmed' || s.id === confirmingId))
    .map((s) => ({
      id: s.id,
      ord: s.ord,
      hash: hashOf(plainText(s.targetTokens!)),
      locked: s.locked,
    }));
  return documentContext(entries);
}
