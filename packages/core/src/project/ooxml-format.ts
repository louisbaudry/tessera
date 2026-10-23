/**
 * What differs between the OOXML formats whose text is paragraphs (DOCX and
 * PPTX, `planning/v1-spec.md` §3.9): how a package is read and written, which
 * element is a paragraph, how a region becomes tokens and tokens become a
 * region, and how a part is named in the project. `assembleOoxml` and
 * `foldSegments` take one, so the segmenting, the hashing, the hidden-tag rule
 * and the fold are written once.
 */

import {
  documentSegments,
  exportDocx,
  importDocx,
  type DocumentSegment,
  type DocxDocument,
} from '../docx/document.js';
import { type RenderDialect, WORD_RENDER, DRAWINGML_RENDER } from '../docx/render.js';
import {
  DRAWINGML_DIALECT,
  WORD_DIALECT,
  type SkeletonDialect,
} from '../docx/skeleton.js';
import { tokenizeRegion } from '../docx/tokenize.js';
import type { FileKind } from '../model/file.js';
import type { DocPart } from '../model/segment.js';
import type { TokenizedRegion } from '../model/token.js';
import { exportPptx, importPptx, pptxSegments } from '../pptx/document.js';
import { tokenizePptxRegion } from '../pptx/tokenize.js';
import { toDocPart, toPartName, toPptxDocPart, toPptxPartName } from './parts.js';

export interface OoxmlFormat {
  readonly kind: FileKind;
  readonly skeleton: SkeletonDialect;
  readonly render: RenderDialect;
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
  render: WORD_RENDER,
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
  render: DRAWINGML_RENDER,
  importDoc: importPptx,
  exportDoc: exportPptx,
  segments: pptxSegments,
  tokenize: tokenizePptxRegion,
  toDocPart: toPptxDocPart,
  toPartName: toPptxPartName,
};
