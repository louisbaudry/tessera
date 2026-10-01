/**
 * Word count of an uploaded file (planning/v1-spec.md §3.6; backlog #62).
 *
 * The portal's advisory estimate: a number for the admin to confirm, never
 * a price. So every way this cannot answer is `null`, never a wrong
 * number — a language that does not space its words, a file that is not
 * what it says, one that inflates past the cap.
 *
 * Deliberately not `assembleFile`. A count needs no segmenter (sentence
 * splitting moves no word), and `assembleFile` would throw on a source
 * language with no segmentation rules, hash every segment, and inflate
 * the whole package for a number. This goes `extractSkeleton` →
 * `tokenizeRegion` → `countRegionWords` over the translatable parts only.
 */

import { unzipSync } from 'fflate';

import { isTranslatablePart } from '../docx/package.js';
import {
  extractSkeleton,
  isUntranslatable,
  type PartSkeleton,
} from '../docx/skeleton.js';
import { tokenizeRegion } from '../docx/tokenize.js';
import { countRegionWords, countWords, hasSpacedWords } from '../model/words.js';
import { fallbackRegionKeys } from './fallback.js';

/**
 * The most a count will inflate: the translatable parts' declared
 * sizes, summed. A count is a courtesy on an upload from anyone holding
 * a client link, and it runs on the request thread, so it gives up
 * (`null`) above this rather than spend seconds and memory on a bomb.
 * 32 MiB of XML is a few million words of prose, an order of magnitude
 * over the largest real fixture; the timings are in the backlog record.
 */
export const MAX_COUNT_INFLATED_BYTES = 32 * 1024 * 1024;

const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });

/** Words in one part's skeleton, outside fallback copies and locked paragraphs. */
function countSkeleton(sk: PartSkeleton): number {
  const skip = fallbackRegionKeys(sk);
  let n = 0;
  for (const region of sk.regions) {
    if (skip.has(region.key) || isUntranslatable(region)) continue;
    n += countRegionWords(tokenizeRegion(region.xml));
  }
  return n;
}

/**
 * Words in a DOCX, or `null` when it cannot be counted: an unspaced
 * source language, bytes that are not a DOCX, malformed XML, or a
 * package that inflates past {@link MAX_COUNT_INFLATED_BYTES}.
 *
 * Counts what `core` extracts (v1-spec.md §3.5): body, tables, text
 * boxes, headers, footers, footnotes and endnotes. Not SmartArt text
 * or image alt-text, which nothing reads yet.
 */
export function countDocxWords(bytes: Uint8Array, srcLang: string): number | null {
  if (!hasSpacedWords(srcLang)) return null;
  try {
    let inflated = 0;
    let tooBig = false;
    const entries = unzipSync(bytes, {
      filter: (file) => {
        if (file.name !== '[Content_Types].xml' && !isTranslatablePart(file.name)) {
          return false;
        }
        inflated += file.originalSize;
        if (inflated > MAX_COUNT_INFLATED_BYTES) tooBig = true;
        return !tooBig;
      },
    });
    if (tooBig) return null;
    if (!entries['[Content_Types].xml'] || !entries['word/document.xml']) return null;

    let total = 0;
    for (const [name, data] of Object.entries(entries)) {
      if (!isTranslatablePart(name)) continue;
      total += countSkeleton(extractSkeleton(name, decoder.decode(data)));
    }
    return total;
  } catch {
    // Not a ZIP, not UTF-8, unscannable XML, or a numeric entity past
    // U+10FFFF (`RangeError`): whatever it was, there is no number.
    return null;
  }
}

/**
 * Words in plain text, or `null` for an unspaced source language or text
 * no editor would show as text (a NUL or other C0 control, which is what
 * BOM-less UTF-16 of ASCII decodes to as UTF-8).
 */
export function countTextWords(text: string, srcLang: string): number | null {
  if (!hasSpacedWords(srcLang)) return null;
  if (/[\u0000-\u0008\u000B\u000E-\u001F]/u.test(text)) return null;
  return countWords(text);
}
