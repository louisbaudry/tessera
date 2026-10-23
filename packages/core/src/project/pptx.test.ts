import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ProjectFile } from '../docx/document.js';
import { getPart, readPptx } from '../docx/package.js';
import type { Segment } from '../model/segment.js';
import { plainText, type Token } from '../model/token.js';
import { rulesFor } from '../segment/rules.js';
import { scanTree } from '../xliff/scan.js';
import { assemblePptx, type AssembledFile } from './assemble.js';
import { exportFileBytes } from './export-any.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/pptx',
);
const load = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

function persisted(name: string): {
  file: ProjectFile;
  segments: Segment[];
  assembled: AssembledFile;
} {
  const assembled = assemblePptx(load(name), rulesFor('en'));
  const file: ProjectFile = {
    id: 5,
    kind: 'pptx',
    relPath: name,
    originalBlob: assembled.originalBlob,
    skeleton: assembled.skeleton,
    partMap: assembled.partMap,
    importedAt: '2026-10-23T00:00:00.000Z',
  };
  const segments = assembled.segments.map((s, i): Segment => ({
    id: i + 1,
    fileId: 5,
    part: s.part,
    ord: s.ord,
    paraKey: s.paraKey,
    paraOrd: s.paraOrd,
    sourceTokens: s.sourceTokens,
    formatTable: s.formatTable,
    targetTokens: null,
    sourceHash: s.sourceHash,
    status: s.status,
    origin: null,
    locked: s.locked,
    fallbackCopy: s.fallbackCopy,
    updatedAt: '2026-10-23T00:00:00.000Z',
  }));
  return { file, segments, assembled };
}

/** A target that keeps the source's tags and changes every text. */
const translate = (segments: Segment[]): Segment[] =>
  segments.map((s) =>
    s.locked
      ? s
      : {
          ...s,
          status: 'translated' as const,
          targetTokens: s.sourceTokens.map((t): Token =>
            t.t === 'text' ? { t: 'text', v: `Ü${t.v}&<` } : t,
          ),
        },
  );

describe('assemblePptx', () => {
  it('stores slides and notes in reading order under slide<n> and notes<n>', () => {
    const { assembled } = persisted('edge-cases.en.pptx');
    expect(assembled.kind).toBe('pptx');
    expect(assembled.partMap).toEqual(
      expect.arrayContaining([
        'ppt/slides/slide2.xml',
        'ppt/notesSlides/notesSlide3.xml',
      ]),
    );
    const parts = [...new Set(assembled.segments.map((s) => s.part))];
    expect(parts).toEqual(['slide2', 'slide1', 'slide3', 'notes1', 'notes3']);
    expect(assembled.segments[0]!.part).toBe('slide2');
    expect(assembled.segments.map((s) => s.ord)).toEqual(
      assembled.segments.map((_, i) => i),
    );
  });

  it('cuts a paragraph into sentences, keeping one paragraph key', () => {
    const { assembled } = persisted('edge-cases.en.pptx');
    const hello = assembled.segments.filter((s) =>
      plainText(s.sourceTokens).includes('Hello'),
    )[0]!;
    const same = assembled.segments.filter(
      (s) => s.paraKey === hello.paraKey && s.part === hello.part,
    );
    expect(same.map((s) => plainText(s.sourceTokens).trim())).toEqual([
      'Hello, world!',
      'Then water and mc.',
    ]);
    expect(same.map((s) => s.paraOrd)).toEqual([0, 1]);
  });

  it('locks digits and a bare field, flags the second copy of a stored-twice box', () => {
    const { assembled } = persisted('edge-cases.en.pptx');
    const locked = assembled.segments
      .filter((s) => s.locked)
      .map((s) => plainText(s.sourceTokens));
    expect(locked).toEqual(expect.arrayContaining(['2026', '']));
    const twice = assembled.segments.filter((s) =>
      plainText(s.sourceTokens).startsWith('Stored twice'),
    );
    expect(twice.map((s) => s.fallbackCopy)).toEqual([false, true]);
  });

  it('segments the LibreOffice deck, notes included', () => {
    const { assembled } = persisted('lo-deck.en.pptx');
    const texts = assembled.segments.map((s) => plainText(s.sourceTokens).trim());
    expect(texts).toContain('Garden planning workshop');
    expect(texts).toContain('Remind the group about mulch & shade cloth.');
    expect(texts).toContain('Early spring, indoors.');
    expect(assembled.segments.at(-1)!.part).toBe('notes2');
  });
});

describe('exporting a PPTX', () => {
  it.each(['edge-cases.en.pptx', 'lo-deck.en.pptx'])(
    'a zero-edit export of %s keeps every part',
    (name) => {
      const { file, segments } = persisted(name);
      const before = readPptx(file.originalBlob);
      const after = readPptx(exportFileBytes(file, segments).bytes);
      for (const part of before.parts) {
        expect(
          Buffer.from(getPart(after, part.name)!).equals(Buffer.from(part.data)),
          part.name,
        ).toBe(true);
      }
    },
  );

  it.each(['edge-cases.en.pptx', 'lo-deck.en.pptx'])(
    'a translated %s is well-formed, keeps its tags and reads back',
    (name) => {
      const { file, segments } = persisted(name);
      const exported = exportFileBytes(file, translate(segments));
      const pkg = readPptx(exported.bytes);

      // Every changed part is well-formed XML; the rest are the original bytes.
      const original = readPptx(file.originalBlob);
      for (const part of pkg.parts) {
        const was = getPart(original, part.name)!;
        if (/^ppt\/(slides|notesSlides)\/\w+\.xml$/.test(part.name)) {
          expect(() => scanTree(decode(part.data)), part.name).not.toThrow();
        } else {
          expect(Buffer.from(part.data).equals(Buffer.from(was)), part.name).toBe(true);
        }
      }

      // Reading the export back gives the translated text, and the same tags.
      const again = assemblePptx(exported.bytes, rulesFor('en'));
      const texts = again.segments
        .filter((s) => !s.locked)
        .map((s) => plainText(s.sourceTokens));
      expect(texts.length).toBeGreaterThan(5);
      expect(texts.every((t) => t.includes('Ü'))).toBe(true);
      // The structure is the same: as many paragraphs, breaks, fields, links
      // and end-of-paragraph properties in every part as there were.
      for (const part of original.parts.filter((p) =>
        /^ppt\/(slides|notesSlides)\/\w+\.xml$/.test(p.name),
      )) {
        const was = decode(part.data);
        const now = decode(getPart(pkg, part.name)!);
        for (const needle of [
          '<a:p>',
          '<a:br',
          '<a:fld ',
          '<a:hlinkClick',
          '<a:endParaRPr',
          'baseline=',
        ]) {
          expect(now.split(needle).length, `${part.name} ${needle}`).toBe(
            was.split(needle).length,
          );
        }
      }
    },
  );

  it('keeps end-of-paragraph properties last, formatting on its run, and the link relationship', () => {
    const { file, segments } = persisted('edge-cases.en.pptx');
    const pkg = readPptx(exportFileBytes(file, translate(segments)).bytes);
    const slide1 = decode(getPart(pkg, 'ppt/slides/slide1.xml')!);

    // a:endParaRPr is the last child of every paragraph that had one.
    for (const m of slide1.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
      const body = m[1]!;
      if (body.includes('<a:endParaRPr')) {
        expect(
          body.trimEnd().endsWith('/>') || body.trimEnd().endsWith('</a:endParaRPr>'),
          body,
        ).toBe(true);
        expect(body.lastIndexOf('<a:endParaRPr')).toBeGreaterThan(
          body.lastIndexOf('</a:r>'),
        );
      }
    }
    // The bold-italic-underline run is still one, with its text translated.
    expect(slide1).toMatch(
      /<a:rPr lang="en-US" b="1" i="1" u="sng" dirty="0">\s*<\/a:rPr><a:t>Üworld&amp;&lt;<\/a:t>/,
    );
    // The hyperlink run still points at rId2, which the slide's rels still define.
    expect(slide1).toContain('<a:hlinkClick r:id="rId2"/>');
    expect(decode(getPart(pkg, 'ppt/slides/_rels/slide1.xml.rels')!)).toContain(
      'https://example.org/workshop',
    );
    // Entities are escaped, never raw.
    expect(slide1).not.toMatch(/<a:t>[^<]*&(?!amp;|lt;|gt;)[^<]*<\/a:t>/);
  });

  it('refuses a segment of another file', () => {
    const { file, segments } = persisted('edge-cases.en.pptx');
    expect(() => exportFileBytes(file, [{ ...segments[0]!, fileId: 99 }])).toThrow(
      /belongs to file 99/,
    );
  });
});
