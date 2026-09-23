/**
 * Project file → translated DOCX (v1-spec.md §3.4's fold rule; backlog #25).
 *
 * The inverse of `assemble.ts`: `assembleFile` cut a document's
 * paragraphs into sentence-level segments, this folds a paragraph's
 * segments back into one region and splices it into the skeleton. Same
 * layer, for the same reason — it needs `segment/` (the fold) and
 * `docx/` (the render and the package), and neither may import the
 * other in this direction.
 *
 * Two halves to the rule, and the first is what keeps the roundtrip
 * gate true through the database: a paragraph none of whose segments
 * has a target is never rendered from tokens — its original XML is
 * spliced back verbatim by `renderSkeleton`'s default. Only a paragraph
 * something was actually translated in is rebuilt, with each segment
 * contributing its target when it has one and its source when it does
 * not.
 */

import { exportDocx, type ProjectFile, type Replacements } from '../docx/document.js';
import { readDocx } from '../docx/package.js';
import { renderTokens } from '../docx/render.js';
import type { Segment } from '../model/segment.js';
import type { TokenizedRegion } from '../model/token.js';
import { mergeSegments } from '../segment/edit.js';
import { toPartName } from './parts.js';

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

export interface ExportSummary {
  /** Paragraphs that produced at least one segment. */
  readonly paragraphs: number;
  /** Paragraphs rebuilt from tokens because a segment of theirs has a target. */
  readonly paragraphsRendered: number;
  readonly segments: number;
  readonly segmentsWithTarget: number;
}

export interface FoldedSegments {
  readonly replacements: Replacements;
  readonly summary: ExportSummary;
}

/**
 * The region a segment contributes to its paragraph's fold: its target
 * when it has one, its source otherwise, over its own format table.
 */
function contribution(segment: Segment): TokenizedRegion {
  return {
    tokens: segment.targetTokens ?? segment.sourceTokens,
    formats: segment.formatTable,
  };
}

/**
 * Folds a file's segments into the per-part, per-region replacements
 * `exportDocx` takes. Segments are grouped by `(part, paraKey)` and
 * folded in `paraOrd` order; the separator is inserted only where
 * neither side brings boundary whitespace, which is the asymmetry
 * between a source piece (carrying the inter-sentence space the
 * segmenter left on it) and a target (which never does).
 */
export function foldSegments(segments: readonly Segment[]): FoldedSegments {
  const paragraphs = new Map<string, Segment[]>();
  for (const segment of segments) {
    const key = `${segment.part}\u0000${segment.paraKey}`;
    const group = paragraphs.get(key);
    if (group) group.push(segment);
    else paragraphs.set(key, [segment]);
  }

  const replacements = new Map<string, Map<string, string>>();
  let paragraphsRendered = 0;
  let segmentsWithTarget = 0;

  for (const group of paragraphs.values()) {
    group.sort((a, b) => a.paraOrd - b.paraOrd);
    const translated = group.filter((s) => s.targetTokens !== null).length;
    segmentsWithTarget += translated;
    if (translated === 0) continue;

    const folded = group
      .map(contribution)
      .reduce((acc, next) => mergeSegments(acc, next, { separator: ' ' }));
    const xml = renderTokens(folded.tokens, folded.formats);

    const first = group[0]!;
    const partName = toPartName(first.part);
    let byKey = replacements.get(partName);
    if (!byKey) {
      byKey = new Map();
      replacements.set(partName, byKey);
    }
    byKey.set(first.paraKey, xml);
    paragraphsRendered++;
  }

  return {
    replacements,
    summary: {
      paragraphs: paragraphs.size,
      paragraphsRendered,
      segments: segments.length,
      segmentsWithTarget,
    },
  };
}

export interface ExportedFile {
  readonly bytes: Uint8Array;
  readonly summary: ExportSummary;
}

/**
 * Renders a project file back to DOCX bytes with its segments' targets
 * spliced in. Refuses a segment that belongs to another file rather
 * than silently rendering it into the wrong document.
 */
export function exportProjectFile(
  file: ProjectFile,
  segments: readonly Segment[],
): ExportedFile {
  const foreign = segments.find((s) => s.fileId !== file.id);
  if (foreign) {
    throw new ExportError(
      `segment ${foreign.id} belongs to file ${foreign.fileId}, not file ${file.id}`,
    );
  }
  const { replacements, summary } = foldSegments(segments);
  const doc = { pkg: readDocx(file.originalBlob), skeletons: file.skeleton };
  return { bytes: exportDocx(doc, replacements), summary };
}
