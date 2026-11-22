/**
 * What differs between the OOXML formats whose text is paragraphs (DOCX, PPTX
 * and XLSX, `planning/v1-spec.md` §3.9, §3.10): how a package is read and
 * written, which element is a paragraph, how a region becomes tokens and
 * tokens become a region, and how a part is named in the project.
 * `assembleOoxml` and `foldSegments` take one, so the segmenting, the hashing,
 * the hidden-tag rule and the fold are written once.
 */

import {
  documentSegments,
  exportDocx,
  importDocx,
  type DocumentSegment,
  type DocxDocument,
} from '../docx/document.js';
import { readDocx, readPptx, readXlsx, type DocxPackage } from '../docx/package.js';
import { DRAWINGML_RENDER, renderTokens, WORD_RENDER } from '../docx/render.js';
import {
  DRAWINGML_DIALECT,
  SHARED_STRING_DIALECT,
  WORD_DIALECT,
  type SkeletonDialect,
} from '../docx/skeleton.js';
import { tokenizeRegion } from '../docx/tokenize.js';
import type { FileKind } from '../model/file.js';
import type { DocPart } from '../model/segment.js';
import type { FormatEntry, Token, TokenizedRegion } from '../model/token.js';
import { exportPptx, importPptx, pptxSegments } from '../pptx/document.js';
import { tokenizePptxRegion } from '../pptx/tokenize.js';
import { exportXlsx, importXlsx, xlsxSegments } from '../xlsx/document.js';
import { renderXlsxTokens } from '../xlsx/render.js';
import { tokenizeXlsxRegion } from '../xlsx/tokenize.js';
import {
  toDocPart,
  toPartName,
  toPptxDocPart,
  toPptxPartName,
  toXlsxDocPart,
  toXlsxPartName,
} from './parts.js';

export interface OoxmlFormat {
  readonly kind: FileKind;
  /** The paragraph element a second copy is looked for by (`fallbackRegionKeys`). */
  readonly skeleton: SkeletonDialect;
  /** Reads the stored original again at export: the parts and their order. */
  readonly readPackage: (bytes: Uint8Array) => DocxPackage;
  /** Tokens → the XML of one region (a paragraph's content, a string's). */
  readonly render: (tokens: readonly Token[], formats: readonly FormatEntry[]) => string;
  readonly importDoc: (bytes: Uint8Array) => DocxDocument;
  readonly exportDoc: (
    doc: DocxDocument,
    replacements?: ReadonlyMap<string, ReadonlyMap<string, string>>,
  ) => Uint8Array;
  readonly segments: (doc: DocxDocument) => DocumentSegment[];
  readonly tokenize: (xml: string) => TokenizedRegion;
  readonly toDocPart: (part: string) => DocPart;
  readonly toPartName: (part: DocPart) => string;
}

export const DOCX_FORMAT: OoxmlFormat = {
  kind: 'docx',
  skeleton: WORD_DIALECT,
  readPackage: readDocx,
  render: (tokens, formats) => renderTokens(tokens, formats, WORD_RENDER),
  importDoc: importDocx,
  exportDoc: exportDocx,
  segments: documentSegments,
  tokenize: tokenizeRegion,
  toDocPart,
  toPartName,
};

export const PPTX_FORMAT: OoxmlFormat = {
  kind: 'pptx',
  skeleton: DRAWINGML_DIALECT,
  readPackage: readPptx,
  render: (tokens, formats) => renderTokens(tokens, formats, DRAWINGML_RENDER),
  importDoc: importPptx,
  exportDoc: exportPptx,
  segments: pptxSegments,
  tokenize: tokenizePptxRegion,
  toDocPart: toPptxDocPart,
  toPartName: toPptxPartName,
};

/**
 * A workbook (`planning/v1-spec.md` §3.10): its "paragraphs" are the shared
 * and inline strings, and a string renders as one `t` or as runs
 * (`renderXlsxTokens`).
 */
export const XLSX_FORMAT: OoxmlFormat = {
  kind: 'xlsx',
  skeleton: SHARED_STRING_DIALECT,
  readPackage: readXlsx,
  render: renderXlsxTokens,
  importDoc: importXlsx,
  exportDoc: exportXlsx,
  segments: xlsxSegments,
  tokenize: tokenizeXlsxRegion,
  toDocPart: toXlsxDocPart,
  toPartName: toXlsxPartName,
};
