import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { importDocx, translatableSegments, type ProjectFile } from '../docx/document.js';
import { readDocx } from '../docx/package.js';
import { regionText } from '../docx/skeleton.js';
import type { Segment } from '../model/segment.js';
import { plainText, type Token } from '../model/token.js';
import { rulesFor } from '../segment/rules.js';
import { assembleFile, type AssembledFile } from './assemble.js';
import { ExportError, exportProjectFile, foldSegments } from './export.js';
import { toPartName } from './parts.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/docx',
);
const load = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const digest = (data: Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');
const partDigests = (bytes: Uint8Array): Map<string, string> =>
  new Map(readDocx(bytes).parts.map((p) => [p.name, digest(p.data)]));

const FILE_ID = 7;

/** What `insertFile` + `listSegments` would hand back, without a database. */
function persisted(name: string): { file: ProjectFile; segments: Segment[] } {
  const assembled: AssembledFile = assembleFile(load(name), rulesFor('en'));
  const file: ProjectFile = {
    id: FILE_ID,
    relPath: name,
    originalBlob: assembled.originalBlob,
    skeleton: assembled.skeleton,
    partMap: assembled.partMap,
    importedAt: '2026-09-20T00:00:00.000Z',
  };
  const segments = assembled.segments.map((s, i): Segment => ({
    id: i + 1,
    fileId: FILE_ID,
    ...s,
    targetTokens: null,
    origin: null,
    updatedAt: file.importedAt,
  }));
  return { file, segments };
}

const withTarget = (segment: Segment, tokens: readonly Token[]): Segment => ({
  ...segment,
  targetTokens: tokens,
  status: 'translated',
  origin: 'tm_exact',
});

/** The text of one paragraph of an exported document. */
function paragraphText(bytes: Uint8Array, part: string, key: string): string {
  const doc = importDocx(bytes);
  const sk = doc.skeletons.find((s) => s.part === part)!;
  return regionText(sk.regions.find((r) => r.key === key)!);
}

/** A paragraph that segmented into several plain-text sentences. */
function multiSentenceParagraph(segments: readonly Segment[]): Segment[] {
  const byPara = new Map<string, Segment[]>();
  for (const s of segments) {
    const k = `${s.part}/${s.paraKey}`;
    byPara.set(k, [...(byPara.get(k) ?? []), s]);
  }
  for (const group of byPara.values()) {
    if (
      group.length >= 2 &&
      group.every((s) => s.sourceTokens.every((t) => t.t === 'text'))
    ) {
      return group;
    }
  }
  throw new Error('fixture has no multi-sentence plain paragraph');
}

describe('foldSegments', () => {
  it('renders nothing when nothing has a target', () => {
    const { segments } = persisted('prose-long.docx');
    const { replacements, summary } = foldSegments(segments);
    expect(replacements.size).toBe(0);
    expect(summary.paragraphsRendered).toBe(0);
    expect(summary.segmentsWithTarget).toBe(0);
    expect(summary.segments).toBe(segments.length);
    expect(summary.paragraphs).toBeGreaterThan(0);
  });

  it('folds a paragraph from targets where present and sources elsewhere', () => {
    const { segments } = persisted('prose-long.docx');
    const group = multiSentenceParagraph(segments);
    const second = group[1]!;
    const edited = segments.map((s) =>
      s.id === second.id ? withTarget(s, [{ t: 'text', v: 'SEGUNDA FRASE.' }]) : s,
    );

    const { replacements, summary } = foldSegments(edited);
    expect(summary.paragraphsRendered).toBe(1);
    expect(summary.segmentsWithTarget).toBe(1);
    const xml = replacements.get(toPartName(second.part))!.get(second.paraKey)!;

    // Source piece 1 kept its trailing text; the target has no leading
    // space of its own, so the fold supplied one; later source pieces
    // still carry the inter-sentence space the segmenter left on them.
    let expected = plainText(group[0]!.sourceTokens);
    for (const s of group.slice(1)) {
      const piece = s.id === second.id ? 'SEGUNDA FRASE.' : plainText(s.sourceTokens);
      const glued = /\s$/.test(expected) || /^\s/.test(piece);
      expected += (glued ? '' : ' ') + piece;
    }
    expect(xml).toContain('SEGUNDA FRASE.');
    expect(xml.replace(/<[^>]+>/g, '')).toBe(expected);
  });
});

describe('exportProjectFile', () => {
  it.each(['form-minimal.docx', 'footnotes-manuscript.docx', 'fields-textboxes.docx'])(
    '%s: no targets → byte-identical to the original, part for part',
    (name) => {
      const { file, segments } = persisted(name);
      const { bytes, summary } = exportProjectFile(file, segments);
      expect(summary.paragraphsRendered).toBe(0);
      const before = partDigests(file.originalBlob);
      const after = partDigests(bytes);
      expect([...after.keys()]).toEqual([...before.keys()]);
      for (const [part, hash] of before) {
        expect(after.get(part), `${name} :: ${part}`).toBe(hash);
      }
    },
  );

  it('splices a translated sentence into its paragraph and leaves the rest', () => {
    const { file, segments } = persisted('prose-long.docx');
    const group = multiSentenceParagraph(segments);
    const first = group[0]!;
    const edited = segments.map((s) =>
      s.id === first.id ? withTarget(s, [{ t: 'text', v: 'PRIMERA.' }]) : s,
    );

    const { bytes, summary } = exportProjectFile(file, edited);
    expect(summary.paragraphsRendered).toBe(1);

    const partName = toPartName(first.part);
    const text = paragraphText(bytes, partName, first.paraKey);
    expect(text.startsWith('PRIMERA.')).toBe(true);
    for (const s of group.slice(1)) {
      expect(text).toContain(plainText(s.sourceTokens).trim());
    }

    // Every other paragraph is still the original bytes' text.
    const original = translatableSegments(importDocx(file.originalBlob));
    const exported = translatableSegments(importDocx(bytes));
    expect(exported.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      if (original[i]!.key === first.paraKey && original[i]!.part === partName) continue;
      expect(exported[i]!.text).toBe(original[i]!.text);
    }
  });

  it('keeps a tagged segment’s formatting around its target', () => {
    const { file, segments } = persisted('form-release.docx');
    const tagged = segments.find(
      (s) =>
        !s.locked &&
        s.formatTable.some((f) => f.visible && f.placement === 'run') &&
        s.sourceTokens.some((t) => t.t === 'text'),
    )!;
    // Same tags, every text token replaced.
    const target = tagged.sourceTokens.map((t) =>
      t.t === 'text' ? { t: 'text' as const, v: 'X' } : t,
    );
    const edited = segments.map((s) => (s.id === tagged.id ? withTarget(s, target) : s));

    const { bytes } = exportProjectFile(file, edited);
    const run = tagged.formatTable.find((f) => f.visible && f.placement === 'run')!;
    const doc = importDocx(bytes);
    const sk = doc.skeletons.find((s) => s.part === toPartName(tagged.part))!;
    const region = sk.regions.find((r) => r.key === tagged.paraKey)!;
    expect(region.xml).toContain(run.open);
    expect(regionText(region)).toContain('X');
  });

  it('refuses a segment from another file', () => {
    const { file, segments } = persisted('form-minimal.docx');
    const stray = { ...segments[0]!, fileId: FILE_ID + 1 };
    expect(() => exportProjectFile(file, [stray, ...segments.slice(1)])).toThrow(
      ExportError,
    );
  });
});
