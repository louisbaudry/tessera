/**
 * Import and export of a whole DOCX — the composition the roundtrip gate
 * asserts (planning/v1-spec.md §3.1, backlog #8).
 *
 * Import reads the package and builds a skeleton per translatable part.
 * Export renders those skeletons and writes the package back. With no
 * replacements the result must reproduce every part of the original
 * exactly; if it does not, the filter would corrupt a client's document
 * on a job where nothing was even translated.
 */

import {
  getPart,
  readDocx,
  replacePart,
  translatableParts,
  writeDocx,
  type DocxPackage,
} from './package.js';
import {
  extractSkeleton,
  isUntranslatable,
  regionText,
  renderSkeleton,
  type PartSkeleton,
} from './skeleton.js';

/**
 * `ignoreBOM` matters: without it TextDecoder silently strips a leading
 * byte-order mark, which would drop three bytes from any part that has one
 * and break byte fidelity invisibly. `fatal` turns malformed UTF-8 into an
 * error rather than a U+FFFD substitution that would corrupt text.
 */
const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
const encoder = new TextEncoder();

export interface DocxDocument {
  readonly pkg: DocxPackage;
  readonly skeletons: readonly PartSkeleton[];
}

/**
 * A `DocxDocument` as persisted in the project database (`v1-spec.md`
 * §4.1's `file` table) — everything needed to reproduce it, plus the
 * segments assembled from it. Lives here rather than in `model/`: it
 * carries a `PartSkeleton[]`, and `model/` must not import from `docx/`.
 *
 * `Segment` itself stays in `model/`; this only adds the file-level
 * envelope around a list of them.
 */
export interface ProjectFile {
  readonly id: number;
  readonly relPath: string;
  /** Untouched source bytes — what `readDocx` was originally given. */
  readonly originalBlob: Uint8Array;
  readonly skeleton: readonly PartSkeleton[];
  /** Part names present, a denormalised projection of `skeleton`. */
  readonly partMap: readonly string[];
  readonly importedAt: string;
}

/** A translatable unit, flattened across every part of the document. */
export interface DocumentSegment {
  readonly part: string;
  /** Region key, unique within its part. */
  readonly key: string;
  /** Position across the whole document. */
  readonly ord: number;
  /** Raw XML of the region. Tokenising this is #9's job. */
  readonly xml: string;
  /** Text with tags discarded. */
  readonly text: string;
  /** No letters — locked rather than presented as a segment (spec §3.5). */
  readonly untranslatable: boolean;
}

/**
 * Reading order across parts: the body, then headers and footers in
 * numeric order, then note bodies. Notes sort last so the editor presents
 * the document and then its notes, rather than interleaving them
 * mid-sentence (spec §3.5).
 */
function partRank(part: string): [number, number] {
  if (part === 'word/document.xml') return [0, 0];
  const header = /^word\/header(\d+)\.xml$/.exec(part);
  if (header) return [1, Number(header[1])];
  const footer = /^word\/footer(\d+)\.xml$/.exec(part);
  if (footer) return [2, Number(footer[1])];
  if (part === 'word/footnotes.xml') return [3, 0];
  if (part === 'word/endnotes.xml') return [4, 0];
  return [5, 0];
}

function comparePartNames(a: string, b: string): number {
  const [ga, na] = partRank(a);
  const [gb, nb] = partRank(b);
  return ga !== gb ? ga - gb : na !== nb ? na - nb : a.localeCompare(b);
}

export function importDocx(bytes: Uint8Array): DocxDocument {
  const pkg = readDocx(bytes);
  const skeletons = translatableParts(pkg)
    .sort(comparePartNames)
    .map((part) => extractSkeleton(part, decoder.decode(getPart(pkg, part)!)));
  return { pkg, skeletons };
}

/**
 * Replacements are keyed by part name, then by region key. Any region not
 * named renders unchanged, so an export with no replacements is a no-op
 * over the document's content.
 */
export type Replacements = ReadonlyMap<string, ReadonlyMap<string, string>>;

export function exportDocx(doc: DocxDocument, replacements?: Replacements): Uint8Array {
  let pkg = doc.pkg;
  for (const sk of doc.skeletons) {
    const rendered = renderSkeleton(sk, replacements?.get(sk.part));
    pkg = replacePart(pkg, sk.part, encoder.encode(rendered));
  }
  return writeDocx(pkg);
}

export function documentSegments(doc: DocxDocument): DocumentSegment[] {
  const out: DocumentSegment[] = [];
  for (const sk of doc.skeletons) {
    for (const region of sk.regions) {
      out.push({
        part: sk.part,
        key: region.key,
        ord: out.length,
        xml: region.xml,
        text: regionText(region),
        untranslatable: isUntranslatable(region),
      });
    }
  }
  return out;
}

/** Segments a translator would actually see. */
export function translatableSegments(doc: DocxDocument): DocumentSegment[] {
  return documentSegments(doc).filter((s) => !s.untranslatable);
}
