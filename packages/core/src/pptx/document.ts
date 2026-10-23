/**
 * Import and export of a whole PPTX (planning/v1-spec.md §3.9; issue #169).
 *
 * The sibling of `docx/document.ts`: read the package, build a skeleton per
 * translatable part (slides and notes pages), render them back. With no
 * replacements the result reproduces every part exactly, which the roundtrip
 * gate asserts over `fixtures/pptx/`.
 *
 * Parts are put in **presentation order**, read from `ppt/presentation.xml`
 * and its relationships, not from the file numbers, because a deck written by
 * another tool need not number its slides in the order they play.
 */

import type { DocumentSegment, DocxDocument } from '../docx/document.js';
import {
  getPart,
  readPptx,
  replacePart,
  writePptx,
  type DocxPackage,
} from '../docx/package.js';
import {
  DRAWINGML_DIALECT,
  extractSkeleton,
  isUntranslatableFor,
  regionTextFor,
  renderSkeleton,
} from '../docx/skeleton.js';

const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
const encoder = new TextEncoder();

const SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/;
const NOTES_RE = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/;

/** Whether a package part holds slide or notes text (the one definition). */
export function isPptxTranslatablePart(name: string): boolean {
  return SLIDE_RE.test(name) || NOTES_RE.test(name);
}

/** Attributes of every `<tag ...>` start tag in `xml`, by name. */
function startTags(xml: string, tag: string): Array<Map<string, string>> {
  const out: Array<Map<string, string>> = [];
  for (const m of xml.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))) {
    const attrs = new Map<string, string>();
    for (const a of m[0].matchAll(/\s([\w:.-]+)="([^"]*)"/g)) attrs.set(a[1]!, a[2]!);
    out.push(attrs);
  }
  return out;
}

/** `target` relative to the part `from`, as a package path. */
function resolveTarget(from: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = from.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}

const relsOf = (part: string): string => {
  const i = part.lastIndexOf('/');
  return `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`;
};

/** A part's relationships by type suffix (`slide`, `notesSlide`), as package paths, in file order. */
function related(pkg: DocxPackage, part: string, typeSuffix: string): string[] {
  const rels = getPart(pkg, relsOf(part));
  if (!rels) return [];
  return startTags(decoder.decode(rels), 'Relationship')
    .filter(
      (r) =>
        r.get('Type')?.endsWith(`/${typeSuffix}`) && r.get('TargetMode') !== 'External',
    )
    .map((r) => resolveTarget(part, r.get('Target') ?? ''));
}

/**
 * The slide parts in the order the deck plays them, from `p:sldIdLst` and the
 * presentation's relationships; null when that cannot be read.
 */
export function slideOrder(pkg: DocxPackage): string[] | null {
  const presentation = getPart(pkg, 'ppt/presentation.xml');
  const rels = getPart(pkg, relsOf('ppt/presentation.xml'));
  if (!presentation || !rels) return null;
  const targetOf = new Map<string, string>();
  for (const r of startTags(decoder.decode(rels), 'Relationship')) {
    const id = r.get('Id');
    if (id !== undefined && r.get('Type')?.endsWith('/slide')) {
      targetOf.set(id, resolveTarget('ppt/presentation.xml', r.get('Target') ?? ''));
    }
  }
  const order: string[] = [];
  for (const sld of startTags(decoder.decode(presentation), 'p:sldId')) {
    const rid = [...sld].find(([k]) => k.endsWith(':id'))?.[1];
    const part = rid === undefined ? undefined : targetOf.get(rid);
    if (part === undefined) return null;
    order.push(part);
  }
  return order;
}

const number = (re: RegExp, part: string): number => Number(re.exec(part)?.[1] ?? 0);

/**
 * The translatable parts in reading order: slides as the deck plays them, then
 * the notes pages in the same order (notes follow, as footnotes follow the body
 * of a DOCX, §3.5). A part the order does not name goes after the ones it does,
 * by file number.
 */
export function orderedPptxParts(pkg: DocxPackage): string[] {
  const present = pkg.parts.map((p) => p.name).filter(isPptxTranslatablePart);
  const slides = present.filter((n) => SLIDE_RE.test(n));
  const notes = present.filter((n) => NOTES_RE.test(n));
  const played = (slideOrder(pkg) ?? []).filter((n) => slides.includes(n));
  const slideRank = new Map(played.map((n, i) => [n, i]));
  const bySlide = (a: string, b: string) =>
    (slideRank.get(a) ?? Infinity) - (slideRank.get(b) ?? Infinity) ||
    number(SLIDE_RE, a) - number(SLIDE_RE, b);
  const orderedSlides = [...slides].sort(bySlide);

  const noteOf = new Map<string, number>();
  orderedSlides.forEach((slide, i) => {
    for (const n of related(pkg, slide, 'notesSlide')) noteOf.set(n, i);
  });
  const orderedNotes = [...notes].sort(
    (a, b) =>
      (noteOf.get(a) ?? Infinity) - (noteOf.get(b) ?? Infinity) ||
      number(NOTES_RE, a) - number(NOTES_RE, b),
  );
  return [...orderedSlides, ...orderedNotes];
}

export function importPptx(bytes: Uint8Array): DocxDocument {
  const pkg = readPptx(bytes);
  const skeletons = orderedPptxParts(pkg).map((part) =>
    extractSkeleton(part, decoder.decode(getPart(pkg, part)!), DRAWINGML_DIALECT),
  );
  return { pkg, skeletons };
}

/**
 * Renders the skeletons back and writes the package. Same contract as
 * {@link exportDocx}: a region not named renders unchanged, so an export with no
 * replacements is each part byte for byte.
 */
export function exportPptx(
  doc: DocxDocument,
  replacements?: ReadonlyMap<string, ReadonlyMap<string, string>>,
): Uint8Array {
  let pkg = doc.pkg;
  for (const sk of doc.skeletons) {
    pkg = replacePart(
      pkg,
      sk.part,
      encoder.encode(renderSkeleton(sk, replacements?.get(sk.part))),
    );
  }
  return writePptx(pkg);
}

/** Every region of the deck, in reading order, as `documentSegments` is for a DOCX. */
export function pptxSegments(doc: DocxDocument): DocumentSegment[] {
  const out: DocumentSegment[] = [];
  for (const sk of doc.skeletons) {
    for (const region of sk.regions) {
      out.push({
        part: sk.part,
        key: region.key,
        ord: out.length,
        xml: region.xml,
        text: regionTextFor(region, DRAWINGML_DIALECT),
        untranslatable: isUntranslatableFor(region, DRAWINGML_DIALECT),
      });
    }
  }
  return out;
}
