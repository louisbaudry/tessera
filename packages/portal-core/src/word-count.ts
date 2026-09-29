/**
 * Word count estimation (portal-v0-spec.md §4; backlog #62).
 *
 * Advisory: the number the admin sees pre-filled and confirms. It never
 * prices an order and the client never sees it. The definition of a word
 * and both counters are `@cat-tool/core`'s (v1-spec.md §3.6); this
 * module decides only *which* counter an upload gets, and that from its
 * name and its bytes, never from the content type the client declared.
 */

import { countDocxWords, countTextWords, countWords } from '@cat-tool/core';

/** One definition of a word, `@cat-tool/core`'s; re-exported, not copied. */
export { countWords };

export interface WordCountInput {
  readonly filename: string;
  readonly bytes: Uint8Array;
  /** The order's source language, which decides whether words can be counted. */
  readonly srcLang: string;
}

/** ZIP local-file-header magic, which every DOCX starts with. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

const isZip = (bytes: Uint8Array): boolean =>
  ZIP_MAGIC.every((byte, i) => bytes[i] === byte);

const extensionOf = (filename: string): string => {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
};

const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });

/**
 * Best-effort word count for one uploaded file, or `null` when there is
 * no number to offer: a format `core` has no filter for (`.pptx`,
 * `.xlsx`, `.pdf`), a file that is not what its extension says, text
 * that is not UTF-8, or a source language that does not space its words.
 * The admin counts those by hand, per §4. Never throws.
 */
export function estimateWordCount(input: WordCountInput): number | null {
  const { filename, bytes, srcLang } = input;
  try {
    switch (extensionOf(filename)) {
      case 'docx':
        return isZip(bytes) ? countDocxWords(bytes, srcLang) : null;
      case 'txt':
        return countTextWords(textDecoder.decode(bytes), srcLang);
      default:
        return null;
    }
  } catch {
    return null;
  }
}
