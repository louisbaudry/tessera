/** Glossary model. See planning/smart-glossary-spec.md §3. */

/**
 * Why a `term_decision` row exists. Closed set: the `.ctg` schema's
 * CHECK constraint is generated from this list, the same way the
 * project schema's `segment.status` is generated from `SEGMENT_STATUSES`
 * — one list to keep in sync, never two.
 */
export const DECISION_KINDS = [
  /** Picked one of the renderings the aligner offered. */
  'accepted_suggestion',
  /** Typed a rendering that was not offered. */
  'custom',
  /** A segment-level departure from the preferred rendering the translator chose to record. */
  'override',
  /** Marked the rendering forbidden (`TermVariant.forbidden`). */
  'deprecation',
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/**
 * A language-neutral term identity. No text lives here — the EN
 * "invoice" and the ES "factura" are two {@link TermVariant}s of one
 * term, which is what makes an EN/ES glossary an ES/EN one for free
 * (the same reason a `.ctm` unit is language-neutral).
 */
export interface Term {
  readonly id: number;
  /** Stable across copies and merges (tm-format-spec.md §7). */
  readonly uuid: string;
  readonly rev: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Tombstone: never hard-deleted, so history survives. */
  readonly deleted: boolean;
}

/**
 * One rendering of a term in one language. A term may carry several in
 * the same language — a preferred one, forbidden ones, two acceptable
 * synonyms — so which is *preferred* is not a field: it is derived from
 * the decision log, never stored (smart-glossary-spec.md §3.3).
 */
export interface TermVariant {
  readonly id: number;
  readonly termId: number;
  /** BCP-47. */
  readonly lang: string;
  readonly rev: number;
  /** As the translator wants it shown. */
  readonly text: string;
  /** `termKey(text)` — what matching compares. */
  readonly plain: string;
  /** Context: "in reference to software, not equipment". */
  readonly note: string | null;
  /** A rendering the client rejected — "never call it X". */
  readonly forbidden: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
}

/**
 * One entry in the append-only decision log: what was offered, what
 * was chosen, by whom, where. Never updated, never deleted — the
 * schema enforces it with triggers. The current preferred rendering
 * is derived from these rows, so it can never disagree with the
 * history that justifies it.
 */
export interface TermDecision {
  readonly id: number;
  readonly termId: number;
  readonly lang: string;
  /** `termKey` of the chosen rendering. */
  readonly chosen: string;
  /** `termKey` of each alternative offered and not taken. */
  readonly rejected: readonly string[];
  readonly kind: DecisionKind;
  readonly sourceProject: string | null;
  /** Segment `ord` where the term was first seen, if known. */
  readonly sourceSegment: number | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string;
}
