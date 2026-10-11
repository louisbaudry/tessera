/**
 * Word count estimation (portal-v0-spec.md §4; backlog #62).
 *
 * Advisory: the number the admin sees pre-filled and confirms. It never
 * prices an order and the client never sees it. The definition of a word
 * and both counters are `@cat-tool/core`'s (v1-spec.md §3.6); this
 * module decides only *which* counter an upload gets, and that from its
 * name and its bytes, never from the content type the client declared.
 */

import {
  countChangedDocxWords,
  countDocxWords,
  countTextWords,
  countWords,
  type ChangedWords,
} from '@cat-tool/core';

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

export interface ChangedWordsInput {
  readonly filename: string;
  readonly bytes: Uint8Array;
  /** The earlier version of the same file, from the order being updated. */
  readonly baseFilename: string;
  readonly baseBytes: Uint8Array;
  readonly srcLang: string;
}

/**
 * The words of a new version that are new or changed against the earlier
 * one (portal-v0-spec.md §4a; backlog #163), or `null`. Only a DOCX can be
 * compared with a DOCX, both judged by name and magic bytes as in
 * {@link estimateWordCount}; `.txt` has no sentence-level segmentation in
 * `core` and is `null`, which leaves the admin to read the file. Never throws.
 */
export function estimateChangedWords(input: ChangedWordsInput): ChangedWords | null {
  try {
    const isDocx = (name: string, bytes: Uint8Array) =>
      extensionOf(name) === 'docx' && isZip(bytes);
    if (!isDocx(input.filename, input.bytes)) return null;
    if (!isDocx(input.baseFilename, input.baseBytes)) return null;
    return countChangedDocxWords(input.bytes, input.baseBytes, input.srcLang);
  } catch {
    return null;
  }
}

/**
 * The earlier file a new upload is a version of: the first candidate with
 * the same name once case is ignored (Word and macOS disagree about it), in
 * the order given. A new name is a new file, matched to nothing: the whole of
 * it is new. Matching on name rather than position means a client who adds a
 * second document does not shift the comparison of the first.
 */
export function matchEarlierFile<T extends { readonly filename: string }>(
  filename: string,
  candidates: readonly T[],
): T | null {
  const wanted = filename.toLowerCase();
  return candidates.find((c) => c.filename.toLowerCase() === wanted) ?? null;
}
