/**
 * Stale work in a memory (`smart-glossary-spec.md` §6.2; backlog #116): which of
 * the matcher's mismatches say a stored translation uses an **old** rendering.
 * Pure, so the rule is provable from strings, and the one place it lives: the
 * scan in `db` and anything that later reads its rows ask here.
 */

import type { AnyToken } from '../model/token.js';
import type { SegmentMismatch } from './mismatch.js';

/**
 * Whether a mismatch is evidence of an old rendering. A forbidden rendering is;
 * so is an acceptable one used instead of the preferred (`found` names it), which
 * is what a ruling that moved the preference leaves behind. A target that merely
 * lacks the preferred rendering and uses none of the others is not: nothing says
 * it is old, and a paraphrase is not rework.
 */
export function isStaleUse(mismatch: Pick<SegmentMismatch, 'kind' | 'found'>): boolean {
  return mismatch.kind === 'forbidden' || mismatch.found !== null;
}

/** The unit's text as the matcher reads it: one text token, whose plain text is the string. */
export const asTextTokens = (plain: string): AnyToken[] => [{ t: 'text', v: plain }];
