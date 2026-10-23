/**
 * DOCX import → persistable project data (v1-spec.md §4.1; backlog #16).
 *
 * The step nothing built so far actually did: turn a `DocxDocument`
 * into the `file` row plus the sentence-level `segment` rows the
 * project schema expects. Sits above `docx/`, `segment/`, and `tm/`
 * deliberately — `docx/` must not depend on `segment/` (the reverse
 * already holds: `segmentTokens` takes a `TokenizedRegion`), so this
 * integration lives in its own layer rather than in either.
 */

import type { DocumentSegment, DocxDocument } from '../docx/document.js';
import type { FileKind } from '../model/file.js';
import type { DocPart, SegmentStatus } from '../model/segment.js';
import type { FormatEntry, Token } from '../model/token.js';
import { segmentTokens, type SegmenterRules } from '../segment/segmenter.js';
import { normalizeTokens } from '../tm/normalize.js';
import { fallbackRegionKeys } from './fallback.js';
import { DOCX_FORMAT, PPTX_FORMAT, type OoxmlFormat } from './ooxml-format.js';

/** A segment as assembled, before it has an id, a file, or a target. */
export interface AssembledSegment {
  readonly part: DocPart;
  /** Position across the whole file, reassigned at sentence granularity —
   *  `DocumentSegment.ord` only counts paragraphs, one level too coarse. */
  readonly ord: number;
  readonly paraKey: string;
  readonly paraOrd: number;
  readonly sourceTokens: readonly Token[];
  readonly formatTable: readonly FormatEntry[];
  readonly sourceHash: string;
  readonly status: SegmentStatus;
  readonly locked: boolean;
  /** Inside an `mc:Fallback` (`fallbackRegionKeys`): counted as its twin. */
  readonly fallbackCopy: boolean;
  /**
   * A target the file arrived with (XLIFF only, §3.8); its status is the
   * segment's `status`. A DOCX import never has one.
   */
  readonly targetTokens?: readonly Token[];
}

export interface AssembledFile {
  readonly kind: FileKind;
  readonly originalBlob: Uint8Array;
  readonly skeleton: DocxDocument['skeletons'];
  readonly partMap: readonly string[];
  readonly segments: readonly AssembledSegment[];
}

/**
 * One paragraph-level `DocumentSegment` into one or more sentence-level
 * `AssembledSegment`s. Untranslatable content (spec §3.5) is never
 * sentence-segmented — there is nothing sentence-shaped about a caption
 * with no letters — and comes back locked, protected from pre-translate
 * from the moment it exists (`isProtectedFromPretranslate`).
 */
function assembleParagraph(
  docSeg: DocumentSegment,
  rules: SegmenterRules,
  format: OoxmlFormat,
): Array<Omit<AssembledSegment, 'ord' | 'fallbackCopy'>> {
  const region = format.tokenize(docSeg.xml);
  const part = format.toDocPart(docSeg.part);

  if (docSeg.untranslatable) {
    const { hash } = normalizeTokens(region.tokens);
    return [
      {
        part,
        paraKey: docSeg.key,
        paraOrd: 0,
        sourceTokens: region.tokens,
        formatTable: region.formats,
        sourceHash: hash,
        status: 'locked',
        locked: true,
      },
    ];
  }

  return segmentTokens(region, rules).map((piece, paraOrd) => {
    const { hash } = normalizeTokens(piece.tokens);
    return {
      part,
      paraKey: docSeg.key,
      paraOrd,
      sourceTokens: piece.tokens,
      formatTable: piece.formats,
      sourceHash: hash,
      status: 'new',
      locked: false,
    };
  });
}

/**
 * Imports a DOCX and assembles everything the project database's `file`
 * and `segment` tables need — tokenized, sentence-segmented per `rules`,
 * and hashed. Reading it back out is #16's repository layer's job, not
 * this function's.
 */
export function assembleFile(bytes: Uint8Array, rules: SegmenterRules): AssembledFile {
  return assembleOoxml(bytes, rules, DOCX_FORMAT);
}

/**
 * {@link assembleFile} for a PPTX (`planning/v1-spec.md` §3.9): slides and notes
 * pages, cut into sentences by `rules` like a DOCX's paragraphs.
 */
export function assemblePptx(bytes: Uint8Array, rules: SegmenterRules): AssembledFile {
  return assembleOoxml(bytes, rules, PPTX_FORMAT);
}

/**
 * {@link assembleFile} for any format with paragraph text (DOCX, PPTX): the
 * format says how its package is read and tokenized, the rest is shared.
 */
export function assembleOoxml(
  bytes: Uint8Array,
  rules: SegmenterRules,
  format: OoxmlFormat,
): AssembledFile {
  const doc = format.importDoc(bytes);
  const fallbacks = new Map(
    doc.skeletons.map((sk) => [sk.part, fallbackRegionKeys(sk, format.skeleton)]),
  );
  const segments: AssembledSegment[] = [];
  let ord = 0;
  for (const docSeg of format.segments(doc)) {
    const fallbackCopy = fallbacks.get(docSeg.part)?.has(docSeg.key) ?? false;
    for (const piece of assembleParagraph(docSeg, rules, format)) {
      segments.push({ ...piece, ord: ord++, fallbackCopy });
    }
  }
  return {
    kind: format.kind,
    originalBlob: bytes,
    skeleton: doc.skeletons,
    partMap: doc.skeletons.map((s) => s.part),
    segments,
  };
}
