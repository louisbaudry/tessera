/**
 * Project file → translated XLIFF (v1-spec.md §3.8; issue #169).
 *
 * The inverse of `assembleXliff`, and the sibling of `exportProjectFile`
 * with the same two properties. The original is edited as a string, never
 * rebuilt: a changed target replaces the content of its `<target>` (or adds
 * one after `</source>`), a changed state replaces an attribute of its
 * `<segment>`, and every other byte of the file stays as it arrived. And what
 * the project did not change is not touched: a segment whose target is the
 * one the file came with is skipped, so a zero-edit export returns the
 * original bytes.
 */

import type { ProjectFile } from '../docx/document.js';
import type { Segment } from '../model/segment.js';
import { readXliff, type XliffSegment } from '../xliff/document.js';
import { newInlineTable, readInline, renderInline } from '../xliff/inline.js';
import { ExportError, type ExportedFile } from './export.js';

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const encoder = new TextEncoder();

/** The `state` a segment's status asks for: only a pre-fill stays `initial`. */
const wantedState = (segment: Segment): 'initial' | 'translated' =>
  segment.status === 'draft' ? 'initial' : 'translated';

/** Whether the state the file has already says what `wanted` does. */
const stateSays = (current: string, wanted: 'initial' | 'translated'): boolean =>
  wanted === 'initial' ? current === 'initial' : current !== 'initial';

/** The `<segment>` start tag with its `state` set. */
function withState(startTag: string, state: string): string {
  const existing = /(\sstate\s*=\s*)(["'])[^"']*\2/;
  if (existing.test(startTag)) {
    return startTag.replace(
      existing,
      (_m, eq: string, q: string) => `${eq}${q}${state}${q}`,
    );
  }
  return startTag.replace(/\s*(\/?>)$/, ` state="${state}"$1`);
}

/** The qualified-name prefix of `<xlf:source>`: `xlf:`; empty when there is none. */
const prefixOf = (name: string): string =>
  name.slice(0, name.length - name.replace(/^.*:/, '').length);

/**
 * Renders a project XLIFF file back to XLIFF bytes with the project's targets
 * spliced in.
 *
 * @throws ExportError for a segment of another file or one the original has no
 *   place for; XliffError for an original that no longer reads.
 */
export function exportXliffFile(
  file: ProjectFile,
  segments: readonly Segment[],
): ExportedFile {
  const foreign = segments.find((s) => s.fileId !== file.id);
  if (foreign) {
    throw new ExportError(
      `segment ${foreign.id} belongs to file ${foreign.fileId}, not file ${file.id}`,
    );
  }
  const doc = readXliff(file.originalBlob);
  const byPosition = new Map<string, XliffSegment>(
    doc.segments.map((s) => [`${s.unitOrd}:${s.segOrd}`, s]),
  );

  const edits: Edit[] = [];
  let segmentsWithTarget = 0;
  let rendered = 0;

  for (const segment of segments) {
    const original = byPosition.get(`${segment.paraKey}:${segment.paraOrd}`);
    if (!original) {
      throw new ExportError(
        `segment ${segment.id} (unit ${segment.paraKey}, segment ${segment.paraOrd}) is not in the original file`,
      );
    }
    const target = segment.targetTokens ?? [];
    if (target.length === 0) continue;
    segmentsWithTarget++;

    // What the file arrived with, read the way import read it, so that equal
    // tokens mean an untouched target.
    const table = newInlineTable();
    readInline(original.source, doc.xml, table);
    const arrived = original.target ? readInline(original.target, doc.xml, table) : [];

    if (JSON.stringify(arrived) !== JSON.stringify(target)) {
      const inner = renderInline(target, segment.formatTable);
      const el = original.target;
      if (el && el.selfClosing) {
        const open = doc.xml.slice(el.start, el.end).replace(/\s*\/>$/, '>');
        edits.push({
          start: el.start,
          end: el.end,
          text: `${open}${inner}</${el.name}>`,
        });
      } else if (el) {
        edits.push({ start: el.contentStart, end: el.contentEnd, text: inner });
      } else {
        const p = prefixOf(original.source.name);
        edits.push({
          start: original.source.end,
          end: original.source.end,
          text: `<${p}target>${inner}</${p}target>`,
        });
      }
      rendered++;
    }

    const wanted = wantedState(segment);
    if (!stateSays(original.state, wanted) && !original.translateNo) {
      const seg = original.segment;
      edits.push({
        start: seg.start,
        end: seg.contentStart,
        text: withState(doc.xml.slice(seg.start, seg.contentStart), wanted),
      });
    }
  }

  const summary = {
    paragraphs: new Set(doc.segments.map((s) => s.unitOrd)).size,
    paragraphsRendered: rendered,
    segments: segments.length,
    segmentsWithTarget,
  };
  if (edits.length === 0) return { bytes: file.originalBlob, summary };

  edits.sort((a, b) => b.start - a.start);
  let xml = doc.xml;
  for (const edit of edits) {
    xml = xml.slice(0, edit.start) + edit.text + xml.slice(edit.end);
  }
  return { bytes: encoder.encode(xml), summary };
}
