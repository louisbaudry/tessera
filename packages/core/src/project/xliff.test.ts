import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ProjectFile } from '../docx/document.js';
import type { Segment } from '../model/segment.js';
import { plainText, type Token } from '../model/token.js';
import { readXliff } from '../xliff/document.js';
import { XliffError } from '../xliff/scan.js';
import type { AssembledFile } from './assemble.js';
import { assembleXliff } from './assemble-xliff.js';
import { exportFileBytes } from './export-any.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/xliff',
);
const load = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const EN_DE = { srcLang: 'en', tgtLang: 'de' };
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** What `insertFile` + `listSegments` would hand back, without a database. */
function persisted(name: string): {
  file: ProjectFile;
  segments: Segment[];
  assembled: AssembledFile;
} {
  const assembled = assembleXliff(load(name), EN_DE);
  const file: ProjectFile = {
    id: 3,
    kind: 'xliff',
    relPath: name,
    originalBlob: assembled.originalBlob,
    skeleton: assembled.skeleton,
    partMap: assembled.partMap,
    importedAt: '2026-10-22T00:00:00.000Z',
  };
  const segments = assembled.segments.map((s, i): Segment => ({
    id: i + 1,
    fileId: 3,
    part: s.part,
    ord: s.ord,
    paraKey: s.paraKey,
    paraOrd: s.paraOrd,
    sourceTokens: s.sourceTokens,
    formatTable: s.formatTable,
    targetTokens: s.targetTokens ?? null,
    sourceHash: s.sourceHash,
    status: s.status,
    origin: null,
    locked: s.locked,
    fallbackCopy: false,
    updatedAt: '2026-10-22T00:00:00.000Z',
  }));
  return { file, segments, assembled };
}

const words = (tokens: readonly Token[] | null) => (tokens ? plainText(tokens) : null);

describe('assembleXliff', () => {
  it('makes one segment per <segment>, in document order, without segmenting', () => {
    const { assembled } = persisted('basic.en-de.xlf');
    expect(assembled.kind).toBe('xliff');
    expect(assembled.partMap).toEqual(['xliff']);
    expect(assembled.segments.map((s) => plainText(s.sourceTokens))).toEqual([
      'The garden gate is open.',
      'Please close it & lock it.',
      'Water the tomato plants daily.',
      'Line one' + 'line two .',
      'Open the shed before noon.',
      'Then compost the leaves.',
      'GATE-4471',
      "A  control code, a <tag> and an apostrophe's tail.",
      'Note: keep the hose coiled.',
      'Half open.',
    ]);
    // Unit ordinal and index in the unit, never the unit's id.
    expect(assembled.segments.map((s) => `${s.paraKey}:${s.paraOrd}`)).toEqual([
      '0:0',
      '0:1',
      '1:0',
      '2:0',
      '3:0',
      '3:1',
      '4:0',
      '5:0',
      '6:0',
      '6:1',
    ]);
    expect(assembled.segments.every((s) => s.part === 'xliff')).toBe(true);
    expect(new Set(assembled.segments.map((s) => s.ord)).size).toBe(10);
  });

  it('locks a translate="no" unit, and leaves the rest new', () => {
    const { assembled } = persisted('basic.en-de.xlf');
    expect(
      assembled.segments.filter((s) => s.locked).map((s) => plainText(s.sourceTokens)),
    ).toEqual(['GATE-4471']);
    expect(
      assembled.segments.filter((s) => !s.locked).every((s) => s.status === 'new'),
    ).toBe(true);
  });

  it('ignores a foreign <source> inside a module element', () => {
    const { assembled } = persisted('basic.en-de.xlf');
    expect(
      assembled.segments.some((s) =>
        plainText(s.sourceTokens).startsWith('Water the plants.'),
      ),
    ).toBe(false);
  });

  it('reads existing targets: initial is a draft, translated and final are translated, blank is none', () => {
    const { assembled } = persisted('prefilled.en-de.xlf');
    expect(
      assembled.segments.map((s) => [s.status, words(s.targetTokens ?? null)]),
    ).toEqual([
      ['translated', 'Die rote Tür ist .'],
      ['draft', 'Zweimal klopfen & warten.'],
      ['translated', 'Warten.'],
      ['new', null],
      ['new', null],
    ]);
  });

  it('shares one tag between a source and its target', () => {
    const { assembled } = persisted('prefilled.en-de.xlf');
    const first = assembled.segments[0]!;
    expect(first.formatTable).toHaveLength(2);
    const ids = (tokens: readonly Token[]) =>
      tokens.filter((t) => t.t !== 'text').map((t) => (t.t === 'close' ? t.id : t.id));
    expect(ids(first.targetTokens!)).toEqual(ids(first.sourceTokens));
  });

  it('accepts a region variant of the project language and refuses another pair', () => {
    expect(() =>
      assembleXliff(load('prefilled.en-de.xlf'), { srcLang: 'en-US', tgtLang: 'de' }),
    ).not.toThrow();
    expect(() =>
      assembleXliff(load('prefilled.en-de.xlf'), { srcLang: 'fr', tgtLang: 'de' }),
    ).toThrow(/source language is en-GB, the project's is fr/);
    expect(() =>
      assembleXliff(load('prefilled.en-de.xlf'), { srcLang: 'en', tgtLang: 'es' }),
    ).toThrow(/target language is de-DE, the project's is es/);
  });

  it('refuses XLIFF 1.2, other XML and bytes that are not UTF-8, by name', () => {
    expect(() => assembleXliff(load('xliff-12.en-de.xlf'), EN_DE)).toThrow(
      /XLIFF 1\.2 is not supported/,
    );
    expect(() => assembleXliff(new TextEncoder().encode('<a/>'), EN_DE)).toThrow(
      /not an XLIFF file/,
    );
    expect(() => assembleXliff(new Uint8Array([0xff, 0xfe, 0x3c, 0x00]), EN_DE)).toThrow(
      /not UTF-8/,
    );
    expect(() =>
      assembleXliff(
        new TextEncoder().encode('<?xml version="1.0" encoding="ISO-8859-1"?><a/>'),
        EN_DE,
      ),
    ).toThrow(/only UTF-8/);
    expect(() =>
      assembleXliff(
        new TextEncoder().encode(
          '<xliff version="2.1" xmlns="urn:oasis:names:tc:xliff:document:2.0"/>',
        ),
        EN_DE,
      ),
    ).toThrow(/no srcLang/);
    expect(() => assembleXliff(new TextEncoder().encode('nonsense'), EN_DE)).toThrow(
      XliffError,
    );
  });
});

describe('exportFileBytes for XLIFF', () => {
  it.each(['basic.en-de.xlf', 'prefilled.en-de.xlf'])(
    'a zero-edit export of %s is the original, byte for byte',
    (name) => {
      const { file, segments } = persisted(name);
      const { bytes } = exportFileBytes(file, segments);
      expect(Buffer.from(bytes).equals(Buffer.from(file.originalBlob))).toBe(true);
    },
  );

  it('writes a new <target> after </source>, sets the state, and touches nothing else', () => {
    const { file, segments } = persisted('basic.en-de.xlf');
    const edited = segments.map((s, i) =>
      i === 1
        ? {
            ...s,
            status: 'confirmed' as const,
            targetTokens: [{ t: 'text', v: 'Bitte schließen & abschließen.' } as Token],
          }
        : s,
    );
    const out = decode(exportFileBytes(file, edited).bytes);
    const original = decode(file.originalBlob);
    expect(out).toContain(
      '<segment id="s2" state="translated">\n          <source>Please close it &amp; lock it.</source><target>Bitte schließen &amp; abschließen.</target>',
    );
    // Removing exactly the two insertions gives the original back.
    expect(
      out
        .replace('<target>Bitte schließen &amp; abschließen.</target>', '')
        .replace('<segment id="s2" state="translated">', '<segment id="s2">'),
    ).toBe(original);
  });

  it('puts the tags back from the format table, and writes the segment in a prefixed file', () => {
    const { file, segments } = persisted('prefilled.en-de.xlf');
    const last = segments[4]!;
    const edited = segments.map((s) =>
      s === last
        ? {
            ...s,
            status: 'draft' as const,
            targetTokens: [{ t: 'text', v: 'Setzen Sie sich.' } as Token],
          }
        : s,
    );
    const out = decode(exportFileBytes(file, edited).bytes);
    expect(out).toContain(
      '<xlf:source>Sit down.</xlf:source><xlf:target>Setzen Sie sich.</xlf:target>',
    );
    expect(out).not.toContain('state="initial"><xlf:source>Sit down');
  });

  it('replaces the content of an existing target, and opens a self-closing one', () => {
    const { file, segments } = persisted('prefilled.en-de.xlf');
    const edited = segments.map((s, i) => {
      if (i === 1)
        return {
          ...s,
          status: 'translated' as const,
          targetTokens: [{ t: 'text', v: 'Klopfen.' } as Token],
        };
      if (i === 3)
        return {
          ...s,
          status: 'translated' as const,
          targetTokens: [{ t: 'text', v: 'Herein.' } as Token],
        };
      return s;
    });
    const out = decode(exportFileBytes(file, edited).bytes);
    expect(out).toContain('<xlf:target>Klopfen.</xlf:target>');
    expect(out).toContain(
      '<xlf:segment state="translated">\n        <xlf:source>Knock twice.</xlf:source>',
    );
    expect(out).toContain(
      '<xlf:source>Come in.</xlf:source>\n        <xlf:target>Herein.</xlf:target>',
    );
    expect(readXliff(exportFileBytes(file, edited).bytes).segments).toHaveLength(5);
  });

  it('writes a changed state for an unchanged target (a confirmed draft)', () => {
    const { file, segments } = persisted('prefilled.en-de.xlf');
    const edited = segments.map((s, i) =>
      i === 1 ? { ...s, status: 'confirmed' as const } : s,
    );
    const out = decode(exportFileBytes(file, edited).bytes);
    expect(
      out.replace(
        '<xlf:segment state="translated">\n        <xlf:source>Knock',
        '<xlf:segment state="initial">\n        <xlf:source>Knock',
      ),
    ).toBe(decode(file.originalBlob));
  });

  it('round-trips a translated export through the reader', () => {
    const { file, segments } = persisted('basic.en-de.xlf');
    const edited = segments.map((s) =>
      s.locked
        ? s
        : {
            ...s,
            status: 'translated' as const,
            // Same tags as the source, every text replaced: the shape a real job has.
            targetTokens: s.sourceTokens.map((t) =>
              t.t === 'text' ? { t: 'text' as const, v: `ü${t.v}&<` } : t,
            ),
          },
    );
    const bytes = exportFileBytes(file, edited).bytes;
    const doc = readXliff(bytes);
    expect(doc.segments).toHaveLength(10);
    const again = assembleXliff(bytes, EN_DE);
    expect(again.segments.filter((s) => s.targetTokens).length).toBe(9);
    expect(again.segments.map((s) => plainText(s.sourceTokens))).toEqual(
      persisted('basic.en-de.xlf').assembled.segments.map((s) =>
        plainText(s.sourceTokens),
      ),
    );
    for (const s of again.segments) {
      if (s.targetTokens) expect(plainText(s.targetTokens)).toContain('ü');
    }
  });

  it('refuses a segment of another file and one the original has no place for', () => {
    const { file, segments } = persisted('basic.en-de.xlf');
    expect(() => exportFileBytes(file, [{ ...segments[0]!, fileId: 99 }])).toThrow(
      /belongs to file 99/,
    );
    expect(() => exportFileBytes(file, [{ ...segments[0]!, paraKey: '77' }])).toThrow(
      /not in the original/,
    );
  });
});
