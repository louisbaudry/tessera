/**
 * What a word is (planning/v1-spec.md §3.6; backlog #62).
 *
 * One definition, for everything that quotes, shows or pays by a count:
 * the portal's advisory estimate now, the editor's "words confirmed /
 * total" (#34) and vendor pay (#49) next. Two splitters had already
 * drifted apart (`\s+` in the portal, `[^\p{L}\p{N}]+` in the TM
 * bench), which is how two screens end up quoting different numbers for
 * one file.
 *
 * Language-free on purpose: a language that does not space its words has
 * no count at all, which is `project/count.ts`'s call, not a
 * different splitter. `model/` imports nothing.
 */

import { primarySubtag } from './lang.js';
import type { Segment } from './segment.js';
import type { FormatEntry, Token, TokenizedRegion } from './token.js';

/**
 * Where two words cannot touch: any Unicode whitespace (which includes
 * NBSP, U+202F and a byte-order mark) plus the zero-width space, which
 * `\s` misses and which is a line-break opportunity, not a joiner.
 *
 * Spelled out as comparisons, not `/[\s\u200B]/`, because it runs once
 * per character over an upload of up to 100 MB on a request thread;
 * `words.test.ts` checks it against that regular expression for every
 * UTF-16 code unit, so the two cannot drift.
 */
export function isWordSeparator(code: number): boolean {
  if (code < 128) return code === 32 || (code >= 9 && code <= 13);
  return (
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200b) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** A letter or number, which a run must hold to be a word. */
const READABLE = /^[\p{L}\p{N}]$/u;

/**
 * Words in a string. A word is a run between separators that holds at
 * least one letter or number, so `e-mail`, `l'homme` and `1,000.50` are
 * one each, and a lone `\u2014`, `\u2022` or `\u00AB` is none.
 *
 * One pass with no intermediate array: splitting 100 MB of text into
 * millions of strings cost seconds. ASCII is decided by comparison;
 * only other characters reach a regular expression.
 */
export function countWords(text: string): number {
  let words = 0;
  let counted = false; // the current run already holds something readable
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isWordSeparator(code)) {
      counted = false;
      continue;
    }
    if (counted) continue;
    if (code < 128) {
      counted =
        (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122);
    } else {
      // An astral letter or number is a surrogate pair: test it whole.
      const point = text.codePointAt(i)!;
      counted = READABLE.test(String.fromCodePoint(point));
      if (point > 0xffff) i++;
    }
    if (counted) words++;
  }
  return words;
}

/**
 * How a placeholder reads in running text, decided per element and never
 * by whether the translator sees it: a hidden `w:proofErr` mid-word and a
 * visible `w:sym` mid-word both leave the word whole.
 *
 * - `space`: a break the reader sees between two words.
 * - `hyphen`: a non-breaking hyphen, which is the character `-`.
 * - anything else joins: it puts nothing between the letters around it.
 */
const SPACE_ELEMENTS = new Set(['w:tab', 'w:ptab', 'w:br', 'w:cr']);
const HYPHEN_ELEMENTS = new Set(['w:noBreakHyphen']);

const ELEMENT_NAME = /^<([A-Za-z][\w.:-]*)/;

function placeholderReading(format: FormatEntry | undefined): string {
  const name = format ? ELEMENT_NAME.exec(format.open)?.[1] : undefined;
  if (name === undefined) return '';
  if (SPACE_ELEMENTS.has(name)) return ' ';
  if (HYPHEN_ELEMENTS.has(name)) return '-';
  return '';
}

/**
 * The text a region reads as, for counting only: its text, with each
 * placeholder standing for what it puts on the page. Not `plainText`
 * (which drops tags, so `a<tab/>b` would join) and not QA's
 * `visibleText` (which turns every placeholder into U+FFFC).
 */
export function readingText(region: TokenizedRegion): string {
  const byId = new Map<number, FormatEntry>(region.formats.map((f) => [f.id, f]));
  let out = '';
  for (const token of region.tokens as readonly Token[]) {
    if (token.t === 'text') out += token.v;
    else if (token.t === 'ph') out += placeholderReading(byId.get(token.fmt));
  }
  return out;
}

/** Words in one tokenized region (a paragraph's content). */
export function countRegionWords(region: TokenizedRegion): number {
  return countWords(readingText(region));
}

/**
 * Languages whose words are not separated by spaces (or, for Tibetan,
 * by a mark this counter does not read): a whitespace count of them is
 * a count of clauses. They get no count at all (v1-spec.md §3.6).
 */
export const UNSPACED_LANGUAGES: readonly string[] = [
  'zh',
  'ja',
  'th',
  'lo',
  'km',
  'my',
  'bo',
];

/** Whether words in `lang` are separated well enough to be counted. */
export function hasSpacedWords(lang: string): boolean {
  return !UNSPACED_LANGUAGES.includes(primarySubtag(lang));
}

/**
 * Words in one stored segment's source (backlog #34): the editor's
 * progress, and vendor pay next (#49). Zero for a locked segment — never
 * translated, never priced — and for a text box's `mc:Fallback` copy,
 * which the reader sees once, in its `mc:Choice` twin (v1-spec.md §3.6).
 * Whether the source language spaces its words at all is the caller's
 * question ({@link hasSpacedWords}): this counts whatever it is given.
 */
export function segmentWords(
  segment: Pick<Segment, 'sourceTokens' | 'formatTable' | 'locked' | 'fallbackCopy'>,
): number {
  if (segment.locked || segment.fallbackCopy) return 0;
  return countRegionWords({ tokens: segment.sourceTokens, formats: segment.formatTable });
}
