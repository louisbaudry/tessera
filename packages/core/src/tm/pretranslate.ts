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

import { plainText } from '../model/token.js';
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
 */
export function placeMatch(
  matchTokens: readonly TmToken[],
  sourceTokens: readonly Token[],
  sourceFormats: readonly FormatEntry[],
): PlacedMatch {
  const remap = remapTmTokens(matchTokens, sourceTokens, sourceFormats);
  if (remap.ok) {
    return { targetTokens: remap.tokens, tagsMatched: true };
  }
  return { targetTokens: [{ t: 'text', v: plainText(matchTokens) }], tagsMatched: false };
}
