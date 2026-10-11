/**
 * How much of a new version of a document is new (portal-v0-spec.md §4a;
 * backlog #163): the advisory figure behind an "update order", where a
 * client sends version 2 of a file already translated and should be
 * quoted for what changed, not for the whole file again.
 *
 * A sentence is unchanged when its normalised hash (`tm-format-spec.md`
 * §4, the TM's own) occurs among the sentences of the earlier version; where
 * it moved to does not matter, because a translator does not retranslate a
 * moved sentence. Everything else, a new or an edited sentence, is changed.
 * That is the segment-level reading the rest of the product uses, which is
 * why this goes through `assembleFile` where the plain count (`count.ts`)
 * deliberately does not: a hash needs the segmenter.
 *
 * Advice, like every figure the portal derives from an upload: `null` for
 * everything this cannot answer, never a wrong number.
 */

import { segmentWords, hasSpacedWords } from '../model/words.js';
import { rulesFor } from '../segment/rules.js';
import { assembleFile, type AssembledSegment } from './assemble.js';
import { countDocxWords } from './count.js';

/** The new version's words, and how many of them are in new or changed sentences. */
export interface ChangedWords {
  /** Words in the new version, by the segmented count (equals `countDocxWords`). */
  readonly words: number;
  /** Words in sentences whose hash is absent from the earlier version. */
  readonly changedWords: number;
}

/** A segment that is translated, hence one that can be unchanged or changed. */
const isCountable = (s: AssembledSegment): boolean => !s.locked && !s.fallbackCopy;

/**
 * Changed words in `newBytes` against `baseBytes`, or `null` when there is
 * no honest figure: a source language that does not space its words or has
 * no segmentation rules, either file not being a DOCX `core` can read, or
 * either exceeding the count cap (`MAX_COUNT_INFLATED_BYTES`, enforced by
 * running the plain counter on both first, so a bomb is refused before the
 * segmenter inflates anything).
 *
 * A formatting-only change moves a sentence's hash (tags are part of what
 * is hashed), so it counts as changed: a quote errs towards the translator,
 * and the admin confirms the figure.
 */
export function countChangedDocxWords(
  newBytes: Uint8Array,
  baseBytes: Uint8Array,
  srcLang: string,
): ChangedWords | null {
  if (!hasSpacedWords(srcLang)) return null;
  try {
    const rules = rulesFor(srcLang);
    if (countDocxWords(newBytes, srcLang) === null) return null;
    if (countDocxWords(baseBytes, srcLang) === null) return null;

    const known = new Set(
      assembleFile(baseBytes, rules)
        .segments.filter(isCountable)
        .map((s) => s.sourceHash),
    );
    let words = 0;
    let changedWords = 0;
    for (const segment of assembleFile(newBytes, rules).segments) {
      if (!isCountable(segment)) continue;
      const n = segmentWords(segment);
      words += n;
      if (!known.has(segment.sourceHash)) changedWords += n;
    }
    return { words, changedWords };
  } catch {
    // `rulesFor` throws for a language with no rules; a DOCX that will not
    // parse throws from the importer: either way there is no number.
    return null;
  }
}
