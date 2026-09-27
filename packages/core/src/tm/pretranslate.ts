/**
 * Pre-translate match placement (v1-spec.md §6.1; backlog #19).
 *
 * Pure decision logic, shared by both of pre-translate's sources — an
 * external TM's retrieved target variant, and another segment in this
 * project whose source hashed the same ("internal propagation", §6.1
 * step 4) — because placing a translation onto a receiving segment is
 * the same problem either way: remap tags by `(kind, order)` via
 * `remapTmTokens` when they correspond, or fall back to the match's
 * plain text with every tag dropped when they don't. `@cat-tool/db`'s
 * orchestration (querying attached TMs, walking confirmed segments,
 * writing the result) is what actually calls this.
 */

import { withoutHiddenTags } from '../model/hidden-tags.js';
import { plainText, xmlLegalText } from '../model/token.js';
import type { FormatEntry, Token, TmToken } from '../model/token.js';
import { remapTmTokens } from './mapping.js';

export interface PlacedMatch {
  readonly targetTokens: readonly Token[];
  /**
   * False when the match's tags didn't correspond to the receiving
   * segment's source and were dropped — v1-spec.md §6.1's "tag
   * multiset differs" case. The caller decides `origin`/`status` and
   * whether to raise a QA issue from this; this module only decides
   * what the target tokens themselves should be.
   */
  readonly tagsMatched: boolean;
}

/**
 * Places a match's tokens onto a receiving segment's source.
 *
 * Tries `remapTmTokens` first: when every tag kind occurs the same
 * number of times in the match as in `sourceTokens`, the match's tags
 * are placed at the receiving segment's own fmt ids (`v1-spec.md`
 * §6.1's "tag multiset ... equals" case) — a real structural
 * correspondence, not a guess. When it doesn't, `remapTmTokens` refuses
 * rather than approximate, and this falls back to the match's plain
 * text as a single untagged token: never a guessed, possibly
 * tag-invalid, placement (`core/tm/mapping.ts`).
 *
 * Either way the text is made something XML can carry (`xmlLegalText`):
 * a memory can hold a vertical tab — PowerPoint's soft line break — that
 * no DOCX can, and a target export refuses would fail the whole file at
 * delivery, not this one segment now.
 */
export function placeMatch(
  matchTokens: readonly TmToken[],
  sourceTokens: readonly Token[],
  sourceFormats: readonly FormatEntry[],
): PlacedMatch {
  const legal = matchTokens.map((t) =>
    t.t === 'text' ? { t: 'text' as const, v: xmlLegalText(t.v) } : t,
  );
  const remap = remapTmTokens(legal, sourceTokens, sourceFormats);
  if (remap.ok) {
    return { targetTokens: remap.tokens, tagsMatched: true };
  }
  // A source with no visible tag leaves the translator nothing to
  // reapply: the text is the whole target, and its hidden tags are
  // carried when it is written (`setSegmentTarget`, `carryHiddenTags`).
  // Most tag mismatches on a real memory are only hidden ones — a
  // spell-check marker here and not there (backlog #29).
  const nothingToPlace = withoutHiddenTags(sourceTokens, sourceFormats).every(
    (t) => t.t === 'text',
  );
  return {
    targetTokens: [{ t: 'text', v: plainText(legal) }],
    tagsMatched: nothingToPlace,
  };
}
