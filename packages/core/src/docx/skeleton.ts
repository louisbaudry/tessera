/**
 * Skeleton extraction (planning/v1-spec.md §3.1).
 *
 * A skeleton is the part's original XML with every translatable region
 * replaced by a marker. Export splices rendered targets back into it, so
 * everything the filter does not model — styles, numbering, tables,
 * drawings, and whatever debris the document carries — is returned
 * untouched.
 *
 * The critical property, and the one #8 tests: rendering a skeleton with
 * unmodified regions must reproduce the original part **byte for byte**.
 * That is achieved by construction rather than by care — regions hold the
 * exact substring they replaced, and the skeleton is built by slicing the
 * original string, never by re-serializing a parsed tree.
 *
 * Skeletons are per part, not per document: footnote and endnote bodies are
 * translatable (§3.5) and a real manuscript can carry ten or more footers.
 */

import { contains, outermost, scanElements, type XmlElement } from './xml-scan.js';

/** A translatable region — currently one paragraph's run content. */
export interface SkeletonRegion {
  /** Marker id, unique within the part. */
  readonly key: string;
  /** Position among regions in this part, in document order. */
  readonly ord: number;
  /**
   * The exact XML this region replaced, with any nested region already
   * substituted by its own marker. Splicing it back reproduces the source.
   */
  readonly xml: string;
  /** Marker keys of regions nested inside this one (text boxes). */
  readonly children: readonly string[];
}

export interface PartSkeleton {
  /** Part name, e.g. `word/document.xml`. */
  readonly part: string;
  /** Original XML with markers in place of regions. */
  readonly skeleton: string;
  readonly regions: readonly SkeletonRegion[];
}

export class SkeletonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkeletonError';
  }
}

const PARAGRAPH = new Set(['w:p']);
const PARA_PROPS = new Set(['w:pPr']);

const marker = (key: string): string => `<!--cat:${key}-->`;
const MARKER_RE = /<!--cat:([A-Za-z0-9_]+)-->/g;

/**
 * Where a paragraph's translatable content begins.
 *
 * `w:pPr` holds paragraph formatting, not content, and must stay in the
 * skeleton — it carries the style reference and numbering that the filter
 * never models but must not lose.
 *
 * Identified by position rather than nesting depth: the schema requires
 * `w:pPr` to be the paragraph's first child, and depth is only comparable
 * between elements found in the same scan.
 */
function contentStartOf(
  xml: string,
  para: XmlElement,
  propsList: readonly XmlElement[],
): number {
  const own = propsList.find(
    (pr) => contains(para, pr) && xml.slice(para.contentStart, pr.start).trim() === '',
  );
  return own ? own.end : para.contentStart;
}

export function extractSkeleton(part: string, xml: string): PartSkeleton {
  const paragraphs = scanElements(xml, PARAGRAPH);
  if (paragraphs.length === 0) {
    return { part, skeleton: xml, regions: [] };
  }
  const propsList = scanElements(xml, PARA_PROPS);

  // Assign keys in document order so `ord` is stable across runs.
  const keyOf = new Map<XmlElement, string>();
  paragraphs.forEach((para, index) => keyOf.set(para, `s${index + 1}`));

  const regions: SkeletonRegion[] = [];

  /**
   * Builds a region's XML, replacing nested paragraphs with their markers.
   * Recurses innermost-first so a parent's text already contains its
   * children's markers by the time it is captured.
   */
  const materialize = (para: XmlElement): string => {
    const from = contentStartOf(xml, para, propsList);
    const to = para.contentEnd;
    const nested = outermost(paragraphs.filter((p) => contains(para, p)));

    const childKeys: string[] = [];
    let out = '';
    let cursor = from;
    for (const child of nested) {
      if (child.start < from) continue; // inside w:pPr; not content
      materialize(child);
      const key = keyOf.get(child)!;
      childKeys.push(key);
      // Replace only the child's *content*. Its <w:p> wrapper and w:pPr stay
      // in the parent, exactly as a top-level paragraph keeps them in the
      // skeleton — otherwise splicing the child back loses its element.
      const childFrom = contentStartOf(xml, child, propsList);
      out += xml.slice(cursor, childFrom) + marker(key);
      cursor = child.contentEnd;
    }
    out += xml.slice(cursor, to);

    const key = keyOf.get(para)!;
    regions.push({ key, ord: 0, xml: out, children: childKeys });
    return out;
  };

  // Only outermost paragraphs are replaced in the skeleton; nested ones are
  // reached through their parent.
  const top = outermost(paragraphs);
  let skeleton = '';
  let cursor = 0;
  for (const para of top) {
    materialize(para);
    const key = keyOf.get(para)!;
    const from = contentStartOf(xml, para, propsList);
    skeleton += xml.slice(cursor, from) + marker(key);
    cursor = para.contentEnd;
  }
  skeleton += xml.slice(cursor);

  // Re-order regions to document order and number them.
  const order = new Map(paragraphs.map((p, i) => [keyOf.get(p)!, i]));
  const ordered = regions
    .sort((a, b) => order.get(a.key)! - order.get(b.key)!)
    .map((r, i) => ({ ...r, ord: i }));

  return { part, skeleton, regions: ordered };
}

/**
 * Splices regions back into a skeleton.
 *
 * `replacements` overrides a region's XML by key; anything absent renders
 * unchanged. With no overrides the result is the original part, byte for
 * byte — the property #8 asserts across the whole corpus.
 */
export function renderSkeleton(
  sk: PartSkeleton,
  replacements?: ReadonlyMap<string, string>,
): string {
  const byKey = new Map(sk.regions.map((r) => [r.key, r]));
  const resolve = (key: string): string => {
    const region = byKey.get(key);
    if (!region) throw new SkeletonError(`unknown region marker: ${key}`);
    return replacements?.get(key) ?? region.xml;
  };

  // Regions may nest, so substitute until no markers remain. Each pass
  // resolves one level; the depth is bounded by the region count.
  let out = sk.skeleton;
  for (let pass = 0; pass <= sk.regions.length; pass++) {
    MARKER_RE.lastIndex = 0;
    if (!MARKER_RE.test(out)) return out;
    MARKER_RE.lastIndex = 0;
    out = out.replace(MARKER_RE, (_match, key: string) => resolve(key));
  }
  throw new SkeletonError('region markers did not resolve; cyclic nesting?');
}

/**
 * Concatenated text of a region, tags discarded.
 *
 * `w:delText` is deliberately excluded: it is text a reviewer struck out,
 * so it is not part of the document as it currently reads and is not what
 * the translator is being asked to translate (planning/v1-spec.md §3.5).
 */
export function regionText(region: SkeletonRegion): string {
  let out = '';
  const re = /<(w:t)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  for (const m of region.xml.matchAll(re)) {
    out += m[2] ?? '';
  }
  return out
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * True when a region carries no letter in any supported language, so it is
 * not worth presenting as a segment (planning/v1-spec.md §3.5).
 */
export function isUntranslatable(region: SkeletonRegion): boolean {
  return !/\p{L}/u.test(regionText(region));
}
