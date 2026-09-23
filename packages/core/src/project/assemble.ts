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

import { documentSegments, importDocx, type DocumentSegment } from '../docx/document.js';
import { tokenizeRegion } from '../docx/tokenize.js';
import type { DocPart, SegmentStatus } from '../model/segment.js';
import type { FormatEntry, Token } from '../model/token.js';
import { segmentTokens, type SegmenterRules } from '../segment/segmenter.js';
import { normalizeTokens } from '../tm/normalize.js';
import { toDocPart } from './parts.js';

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
}

export interface AssembledFile {
  readonly originalBlob: Uint8Array;
  readonly skeleton: ReturnType<typeof importDocx>['skeletons'];
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
): Array<Omit<AssembledSegment, 'ord'>> {
  const region = tokenizeRegion(docSeg.xml);
  const part = toDocPart(docSeg.part);

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
  const doc = importDocx(bytes);
  const segments: AssembledSegment[] = [];
  let ord = 0;
  for (const docSeg of documentSegments(doc)) {
    for (const piece of assembleParagraph(docSeg, rules)) {
      segments.push({ ...piece, ord: ord++ });
    }
  }
  return {
    originalBlob: bytes,
    skeleton: doc.skeletons,
    partMap: doc.skeletons.map((s) => s.part),
    segments,
  };
}
