/**
 * Package part name ↔ `DocPart` (v1-spec.md §3.5, §4.1).
 *
 * The one definition of the mapping, in both directions: `assembleFile`
 * stores a segment's part as the short `DocPart` the schema names
 * (`'document'`, `'header3'`), and export has to find that segment's
 * skeleton again under the package's own part name
 * (`'word/document.xml'`, `'word/header3.xml'`). Two copies of this
 * table could drift on the day someone adds a part kind to one of them.
 */

import type { DocPart } from '../model/segment.js';

const HEADER_RE = /^word\/header(\d+)\.xml$/;
const FOOTER_RE = /^word\/footer(\d+)\.xml$/;

/** Maps a package part path to the `DocPart` the project schema stores. */
export function toDocPart(part: string): DocPart {
  if (part === 'word/document.xml') return 'document';
  if (part === 'word/footnotes.xml') return 'footnotes';
  if (part === 'word/endnotes.xml') return 'endnotes';
  const header = HEADER_RE.exec(part);
  if (header) return `header${Number(header[1])}`;
  const footer = FOOTER_RE.exec(part);
  if (footer) return `footer${Number(footer[1])}`;
  throw new Error(`unrecognised translatable part: "${part}"`);
}

/** The inverse: the package part path a stored `DocPart` came from. */
export function toPartName(part: DocPart): string {
  if (part === 'document') return 'word/document.xml';
  if (part === 'footnotes') return 'word/footnotes.xml';
  if (part === 'endnotes') return 'word/endnotes.xml';
  if (part.startsWith('header')) return `word/${part}.xml`;
  if (part.startsWith('footer')) return `word/${part}.xml`;
  throw new Error(`unrecognised document part: "${part as string}"`);
}
