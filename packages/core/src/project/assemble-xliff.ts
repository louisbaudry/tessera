/**
 * XLIFF import → persistable project data (v1-spec.md §3.8; issue #169).
 *
 * The sibling of `assembleFile` for an XLIFF 2.x file. It differs in the one
 * way that matters: it does **not** sentence-segment. An XLIFF file arrives
 * segmented by the tool that made it, and export finds a segment again by its
 * position in the document, so one `<segment>` is one stored segment and the
 * segmenter's rules are never consulted.
 */

import type { FileKind } from '../model/file.js';
import { primarySubtag } from '../model/lang.js';
import type { SegmentStatus } from '../model/segment.js';
import type { Token } from '../model/token.js';
import { normalizeTokens } from '../tm/normalize.js';
import { readXliff } from '../xliff/document.js';
import { newInlineTable, readInline } from '../xliff/inline.js';
import { XliffError } from '../xliff/scan.js';
import type { AssembledFile, AssembledSegment } from './assemble.js';

/** The project languages the file must be for. */
export interface XliffLanguages {
  readonly srcLang: string;
  readonly tgtLang: string;
}

/** `kind` of an XLIFF file, as `file.kind` stores it. */
export const XLIFF_KIND: FileKind = 'xliff';

/** A target is blank when it holds no text and no tag: `<target/>`. */
const isBlank = (tokens: readonly Token[]): boolean => tokens.length === 0;

/**
 * The status a target that arrives gets. `initial` (and no state) is a
 * pre-fill, so a `draft`; the rest are a translator's work in the other
 * tool, `translated`. Never `confirmed`: confirming is a person's act here,
 * and it writes the memory (§3.8).
 */
export function statusOfState(state: string): SegmentStatus {
  return state === 'initial' ? 'draft' : 'translated';
}

/**
 * Reads an XLIFF 2.x file into the `file` row and `segment` rows a project
 * stores.
 *
 * @param bytes the file as received; kept verbatim as the original.
 * @param languages the project's pair; the file's `srcLang` (and `trgLang`
 *   when it names one) must match on the primary subtag.
 * @throws XliffError for a file that cannot be read, is XLIFF 1.2, or is for
 *   another language pair than the project's.
 */
export function assembleXliff(
  bytes: Uint8Array,
  languages: XliffLanguages,
): AssembledFile {
  const doc = readXliff(bytes);

  if (primarySubtag(doc.srcLang) !== primarySubtag(languages.srcLang)) {
    throw new XliffError(
      `the file's source language is ${doc.srcLang}, the project's is ${languages.srcLang}`,
    );
  }
  if (doc.trgLang && primarySubtag(doc.trgLang) !== primarySubtag(languages.tgtLang)) {
    throw new XliffError(
      `the file's target language is ${doc.trgLang}, the project's is ${languages.tgtLang}`,
    );
  }

  const segments: AssembledSegment[] = doc.segments.map((seg, ord) => {
    const table = newInlineTable();
    const sourceTokens = readInline(seg.source, doc.xml, table);
    const targetTokens = seg.target ? readInline(seg.target, doc.xml, table) : [];
    const locked = seg.translateNo || sourceTokens.length === 0;
    const hasTarget = !isBlank(targetTokens);
    const status: SegmentStatus = locked
      ? 'locked'
      : hasTarget
        ? statusOfState(seg.state)
        : 'new';
    return {
      part: 'xliff',
      ord,
      paraKey: String(seg.unitOrd),
      paraOrd: seg.segOrd,
      sourceTokens,
      formatTable: table.entries,
      sourceHash: normalizeTokens(sourceTokens).hash,
      status,
      locked,
      fallbackCopy: false,
      ...(hasTarget ? { targetTokens } : {}),
    };
  });

  return {
    kind: XLIFF_KIND,
    originalBlob: bytes,
    skeleton: [],
    partMap: ['xliff'],
    segments,
  };
}
