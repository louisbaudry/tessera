/**
 * Import and export of a whole XLSX (planning/v1-spec.md §3.10; issue #169).
 *
 * The sibling of `docx/document.ts` and `pptx/document.ts`: read the package,
 * build a skeleton per part that holds translatable text, render them back.
 * With no replacements the result reproduces every part exactly, which the
 * roundtrip gate asserts over `fixtures/xlsx/`.
 *
 * A workbook's text is not where its cells are. A cell holds an index into
 * `xl/sharedStrings.xml`, and one string may serve many cells; a few writers
 * put the text in the cell instead (an inline string). So the "paragraphs"
 * are the shared strings (`si`) and the inline strings (`is`), and the sheets
 * are read only to say **in which order** a reader meets them and **which of
 * them must not change** (a table's header and totals rows, see
 * {@link xlsxSegments}).
 */

import type { DocumentSegment, DocxDocument } from '../docx/document.js';
import {
  DocxError,
  getPart,
  readXlsx,
  replacePart,
  writeXlsx,
  type DocxPackage,
} from '../docx/package.js';
import { related, relationships, startTags } from '../docx/relationships.js';
import {
  extractSkeleton,
  INLINE_STRING_DIALECT,
  isUntranslatableFor,
  regionTextFor,
  renderSkeleton,
  SHARED_STRING_DIALECT,
  type PartSkeleton,
  type SkeletonDialect,
} from '../docx/skeleton.js';

const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
const encoder = new TextEncoder();

const WORKBOOK = 'xl/workbook.xml';

/** Where the shared strings must be for a segment's part to name them (`strings`). */
export const SHARED_STRINGS_PART = 'xl/sharedStrings.xml';

const SHEET_RE = /^xl\/worksheets\/sheet(\d+)\.xml$/;

const sheetNumber = (part: string): number => Number(SHEET_RE.exec(part)?.[1] ?? 0);

/** The dialect a part's strings are read with: `si` in the shared strings, `is` in a sheet. */
export function xlsxDialectOf(part: string): SkeletonDialect {
  return part === SHARED_STRINGS_PART ? SHARED_STRING_DIALECT : INLINE_STRING_DIALECT;
}

/** The name of a part's root element, prefix included (`sst`, `x:sst`). */
function rootName(xml: string): string {
  return (
    /<([A-Za-z_][\w.:-]*)(?=[\s>/])/.exec(xml.replace(/<\?[\s\S]*?\?>/g, ''))?.[1] ?? ''
  );
}

/**
 * Refuses a part written with a namespace prefix (`<x:sst>`, as some
 * generators write SpreadsheetML). Every element name here is read without
 * one, so such a workbook would import as no text at all; saying so beats an
 * empty file nobody can explain.
 */
function requireUnprefixed(part: string, xml: string, root: string): void {
  const name = rootName(xml);
  if (name === root) return;
  throw new DocxError(
    name.endsWith(`:${root}`)
      ? `${part} writes its elements with a namespace prefix (<${name}>), which is not supported`
      : `${part} is not a <${root}> part (found <${name}>)`,
  );
}

/**
 * The worksheets in the order the workbook lists them (its tabs, left to
 * right), from `xl/workbook.xml` and its relationships. A sheet the workbook
 * does not name, or every sheet when the order cannot be read, follows by file
 * number. Chart sheets and dialog sheets hold no cells and are not listed.
 */
export function sheetOrder(pkg: DocxPackage): string[] {
  const present = new Set(pkg.parts.map((p) => p.name));
  const targetOf = new Map<string, string>();
  for (const r of relationships(pkg, WORKBOOK, 'worksheet')) {
    if (r.id !== undefined && present.has(r.target)) targetOf.set(r.id, r.target);
  }
  const listed: string[] = [];
  const workbook = getPart(pkg, WORKBOOK);
  if (workbook) {
    for (const sheet of startTags(decoder.decode(workbook), 'sheet')) {
      const rid = [...sheet].find(([k]) => k.endsWith(':id'))?.[1];
      const part = rid === undefined ? undefined : targetOf.get(rid);
      if (part !== undefined && !listed.includes(part)) listed.push(part);
    }
  }
  const rest = [
    ...new Set([...targetOf.values(), ...[...present].filter((n) => SHEET_RE.test(n))]),
  ]
    .filter((n) => !listed.includes(n))
    .sort((a, b) => sheetNumber(a) - sheetNumber(b) || a.localeCompare(b));
  return [...listed, ...rest];
}

/** The shared strings part the workbook names, or null when it has none. */
function sharedStringsPart(pkg: DocxPackage): string | null {
  const named = related(pkg, WORKBOOK, 'sharedStrings')[0];
  if (named !== undefined) return getPart(pkg, named) ? named : null;
  return getPart(pkg, SHARED_STRINGS_PART) ? SHARED_STRINGS_PART : null;
}

/** One string a cell shows: where the cell is, and which string. */
export interface CellString {
  /** The cell's column and row, 1-based (`B7` is column 2, row 7). */
  readonly col: number;
  readonly row: number;
  /** Index into the shared strings, for a `t="s"` cell. */
  readonly shared?: number;
  /** Ordinal of the cell's `is` among the sheet's, for a `t="inlineStr"` cell. */
  readonly inline?: number;
}

const CELL_EVENTS =
  /<row(?=[\s>/])([^>]*)>|<c(?=[\s>/])([^>]*)>|<v>([^<]*)<\/v>|<is(?=[\s>/])|<\/c>/g;

/** `B7` → column 2, row 7; null for anything that is not a cell reference. */
function parseCell(ref: string): { col: number; row: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col, row: Number(m[2]) };
}

/**
 * The strings a sheet's cells show, in document order (row by row, as a
 * reader meets them), each with the cell's position. A formula's cached text
 * (`t="str"`) is not one: it is computed, and recomputed when the workbook is.
 *
 * **A cell's reference and a row's number are optional** in the format: a
 * cell that gives none is the one after the cell before it (the first of its
 * row is column 1), and a row that gives none follows the row before it. The
 * position is worked out here for every cell, so nothing downstream (the
 * table lock) depends on a writer having spelled it out.
 *
 * The inline ordinal counts every `<is>` in the part, which is how
 * `extractSkeleton` keys them (`s<n>`, n-th in document order).
 */
export function cellStrings(sheetXml: string): CellString[] {
  const out: CellString[] = [];
  let row = 0;
  let col = 0;
  let cell: { type: string | undefined } | null = null;
  let inline = 0;
  for (const m of sheetXml.matchAll(CELL_EVENTS)) {
    if (m[1] !== undefined) {
      const given = Number(/\sr="(\d+)"/.exec(m[1])?.[1] ?? NaN);
      row = Number.isInteger(given) && given > 0 ? given : row + 1;
      col = 0;
    } else if (m[2] !== undefined) {
      const at = parseCell(/\sr="([^"]*)"/.exec(m[2])?.[1] ?? '');
      if (at) ({ col, row } = at);
      else col += 1;
      // A self-closed cell (`<c r="A1" s="3"/>`) takes its place and holds nothing.
      cell = m[2].endsWith('/') ? null : { type: /\st="([^"]*)"/.exec(m[2])?.[1] };
    } else if (m[0] === '</c>') {
      cell = null;
    } else if (m[3] !== undefined) {
      if (cell?.type === 's' && /^\d+$/.test(m[3].trim())) {
        out.push({ col, row, shared: Number(m[3].trim()) });
      }
    } else {
      // `<is`: counted wherever it stands, so the ordinal stays the skeleton's.
      const ordinal = inline++;
      if (cell) out.push({ col, row, inline: ordinal });
    }
  }
  return out;
}

/** A rectangle of cells, 1-based, inclusive. */
interface CellRange {
  readonly col1: number;
  readonly row1: number;
  readonly col2: number;
  readonly row2: number;
}

function parseRange(ref: string): CellRange | null {
  const [a, b] = ref.split(':');
  const first = a === undefined ? null : parseCell(a);
  const last = b === undefined ? first : parseCell(b);
  if (!first || !last) return null;
  return {
    col1: Math.min(first.col, last.col),
    row1: Math.min(first.row, last.row),
    col2: Math.max(first.col, last.col),
    row2: Math.max(first.row, last.row),
  };
}

/**
 * The cells of a sheet whose text a table repeats in its own part: its header
 * row (`tableColumn/@name` is the header cell's text) and its totals row
 * (`totalsRowLabel`). Translating the cell and not the table part leaves the
 * two disagreeing, which a reader of the workbook may not accept, so these
 * cells stay as they are. What is known and what is only caution: §3.10.
 */
export function tableLockedRanges(pkg: DocxPackage, sheet: string): CellRange[] {
  const out: CellRange[] = [];
  for (const part of related(pkg, sheet, 'table')) {
    const data = getPart(pkg, part);
    if (!data) continue;
    const table = startTags(decoder.decode(data), 'table')[0];
    const range = parseRange(table?.get('ref') ?? '');
    if (!table || !range) continue;
    // A table has one header row unless it says none, and no totals row unless it says so.
    const headers = Number(table.get('headerRowCount') ?? '1');
    const totals = Number(table.get('totalsRowCount') ?? '0');
    if (headers > 0) out.push({ ...range, row2: range.row1 + headers - 1 });
    if (totals > 0) out.push({ ...range, row1: range.row2 - totals + 1 });
  }
  return out;
}

const within = (range: CellRange, cell: { col: number; row: number }): boolean =>
  cell.col >= range.col1 &&
  cell.col <= range.col2 &&
  cell.row >= range.row1 &&
  cell.row <= range.row2;

export function importXlsx(bytes: Uint8Array): DocxDocument {
  const pkg = readXlsx(bytes);
  requireUnprefixed(WORKBOOK, decoder.decode(getPart(pkg, WORKBOOK)!), 'workbook');
  const skeletons: PartSkeleton[] = [];

  const strings = sharedStringsPart(pkg);
  if (strings !== null) {
    if (strings !== SHARED_STRINGS_PART) {
      throw new DocxError(
        `shared strings at ${strings}: only ${SHARED_STRINGS_PART} is supported`,
      );
    }
    const xml = decoder.decode(getPart(pkg, strings)!);
    requireUnprefixed(strings, xml, 'sst');
    skeletons.push(extractSkeleton(strings, xml, SHARED_STRING_DIALECT));
  }

  for (const sheet of sheetOrder(pkg)) {
    const xml = decoder.decode(getPart(pkg, sheet)!);
    requireUnprefixed(sheet, xml, 'worksheet');
    // Most sheets hold no inline string: they are read for their order
    // (`xlsxSegments`) and never rewritten, so they need no skeleton.
    if (!/<is(?=[\s>/])/.test(xml)) continue;
    if (!SHEET_RE.test(sheet)) {
      throw new DocxError(
        `inline strings in ${sheet}: only xl/worksheets/sheet<n>.xml is supported`,
      );
    }
    skeletons.push(extractSkeleton(sheet, xml, INLINE_STRING_DIALECT));
  }
  return { pkg, skeletons };
}

/**
 * Renders the skeletons back and writes the package. Same contract as
 * `exportDocx`: a region not named renders unchanged, so an export with no
 * replacements is each part byte for byte.
 */
export function exportXlsx(
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
  return writeXlsx(pkg);
}

/**
 * The workbook's strings in reading order: sheet by sheet as the tabs stand,
 * each sheet row by row, a string where a cell **first** shows it (a shared
 * string used by forty cells is one segment, translated once).
 *
 * Three kinds of string are not what `documentSegments` would make of them:
 *
 * - A shared string **no cell shows** is not listed: a workbook keeps strings
 *   its cells no longer use, and nobody reading it would see them.
 * - An **empty** string is not listed either: there is nothing in it.
 * - A string shown in a **table's header or totals row** is listed as
 *   untranslatable (locked), wherever else it is also shown: see
 *   {@link tableLockedRanges}.
 */
export function xlsxSegments(doc: DocxDocument): DocumentSegment[] {
  const regions = new Map(
    doc.skeletons.map((sk) => [sk.part, new Map(sk.regions.map((r) => [r.key, r]))]),
  );
  const order: Array<{ part: string; key: string }> = [];
  const seen = new Set<string>();
  const locked = new Set<string>();

  for (const sheet of sheetOrder(doc.pkg)) {
    const ranges = tableLockedRanges(doc.pkg, sheet);
    for (const use of cellStrings(decoder.decode(getPart(doc.pkg, sheet)!))) {
      // `extractSkeleton` keys a part's strings `s<n>`, n-th in document order.
      const part = use.shared !== undefined ? SHARED_STRINGS_PART : sheet;
      const key = `s${(use.shared ?? use.inline!) + 1}`;
      const id = `${part}\u0000${key}`;
      if (!seen.has(id)) {
        seen.add(id);
        order.push({ part, key });
      }
      if (ranges.some((range) => within(range, use))) locked.add(id);
    }
  }

  const out: DocumentSegment[] = [];
  for (const { part, key } of order) {
    // An index past the end of the shared strings names nothing.
    const region = regions.get(part)?.get(key);
    if (!region) continue;
    const dialect = xlsxDialectOf(part);
    const text = regionTextFor(region, dialect);
    if (text === '') continue;
    out.push({
      part,
      key,
      ord: out.length,
      xml: region.xml,
      text,
      untranslatable:
        locked.has(`${part}\u0000${key}`) || isUntranslatableFor(region, dialect),
    });
  }
  return out;
}
