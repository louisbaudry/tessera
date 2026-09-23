/**
 * DOCX container read/write.
 *
 * A `.docx` is a ZIP of XML and binary parts. The filter rewrites only the
 * parts holding translatable text (planning/v1-spec.md §3.1); everything
 * else — styles, numbering, themes, embedded fonts, images, and whatever
 * debris the document happens to carry — must come back out exactly as it
 * went in.
 *
 * This module is deliberately dumb: it moves bytes and preserves order. It
 * does not parse XML, and it does not know what a paragraph is.
 */

import { unzipSync, zipSync } from 'fflate';

/** One entry in the package, as raw (decompressed) bytes. */
export interface DocxPart {
  readonly name: string;
  readonly data: Uint8Array;
}

/**
 * The parts of a DOCX, in their original order.
 *
 * Order is preserved rather than normalised. `[Content_Types].xml`
 * conventionally comes first, and while Word tolerates reordering, other
 * consumers in a translation pipeline may not — and reordering would be a
 * change we gain nothing from.
 */
export interface DocxPackage {
  readonly parts: readonly DocxPart[];
}

export class DocxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocxError';
  }
}

/** Parts every DOCX must have for us to treat it as one. */
const REQUIRED_PARTS = ['[Content_Types].xml', 'word/document.xml'] as const;

export function readDocx(bytes: Uint8Array): DocxPackage {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (cause) {
    throw new DocxError(
      `not a readable ZIP container: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const parts: DocxPart[] = [];
  for (const [name, data] of Object.entries(entries)) {
    // Directory entries carry no content and are reconstructed implicitly.
    if (name.endsWith('/')) continue;
    parts.push({ name, data });
  }

  for (const required of REQUIRED_PARTS) {
    if (!parts.some((p) => p.name === required)) {
      throw new DocxError(`missing required part: ${required}`);
    }
  }
  return { parts };
}

export function writeDocx(pkg: DocxPackage): Uint8Array {
  const seen = new Set<string>();
  const entries: Record<string, Uint8Array> = {};
  for (const part of pkg.parts) {
    if (seen.has(part.name)) {
      throw new DocxError(`duplicate part: ${part.name}`);
    }
    seen.add(part.name);
    entries[part.name] = part.data;
  }
  for (const required of REQUIRED_PARTS) {
    if (!seen.has(required)) {
      throw new DocxError(`refusing to write a package missing ${required}`);
    }
  }
  // level 6 is the usual default; the container's own bytes are not
  // required to match, only each part's decompressed content.
  return zipSync(entries, { level: 6 });
}

export function getPart(pkg: DocxPackage, name: string): Uint8Array | undefined {
  return pkg.parts.find((p) => p.name === name)?.data;
}

/**
 * Returns a package with one part's bytes replaced, leaving order and every
 * other part untouched. Throws if the part is absent — silently adding it
 * would mask a wrong part name.
 */
export function replacePart(
  pkg: DocxPackage,
  name: string,
  data: Uint8Array,
): DocxPackage {
  let found = false;
  const parts = pkg.parts.map((p) => {
    if (p.name !== name) return p;
    found = true;
    return { name, data };
  });
  if (!found) throw new DocxError(`cannot replace absent part: ${name}`);
  return { parts };
}

/**
 * Names of the parts that hold translatable text (planning/v1-spec.md §3.5):
 * the body, headers and footers, and footnote / endnote bodies.
 *
 * Everything else passes through untouched.
 */
export function translatableParts(pkg: DocxPackage): string[] {
  return pkg.parts
    .map((p) => p.name)
    .filter((n) =>
      /^word\/(document|footnotes|endnotes|header\d+|footer\d+)\.xml$/.test(n),
    );
}
