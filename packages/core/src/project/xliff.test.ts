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
import { assembleXliff, joinNotes } from './assemble-xliff.js';
import { exportFileBytes } from './export-any.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/xliff',
);
const load = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const EN_DE = { srcLang: 'en', tgtLang: 'de' };
const EN_UK = { srcLang: 'en', tgtLang: 'uk' };
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** What `insertFile` + `listSegments` would hand back, without a database. */
function persisted(
  name: string,
  langs: { srcLang: string; tgtLang: string } = EN_DE,
): {
  file: ProjectFile;
  segments: Segment[];
  assembled: AssembledFile;
} {
  const assembled = assembleXliff(load(name), langs);
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

  describe('the reviewed state (issue #358)', () => {
    const states = (xml: string): (string | undefined)[] =>
      [...xml.matchAll(/<xlf:segment\b([^>]*)>/g)].map(
        (m) => /state="([^"]*)"/.exec(m[1]!)?.[1],
      );

    it('writes final for a confirmed segment only when asked, and leaves the rest as they are', () => {
      const { file, segments } = persisted('prefilled.en-de.xlf');
      // 0 translated (kept), 1 draft (confirmed here), 2 final already (translated by status).
      const edited = segments.map((s, i) =>
        i === 1 ? { ...s, status: 'confirmed' as const } : s,
      );
      const asked = decode(exportFileBytes(file, edited, { reviewedState: true }).bytes);
      expect(states(asked).slice(0, 3)).toEqual(['translated', 'final', 'final']);
      const plain = decode(exportFileBytes(file, edited).bytes);
      expect(states(plain).slice(0, 3)).toEqual(['translated', 'translated', 'final']);
      // The option changes the state attribute and nothing else.
      expect(
        asked.replace(
          'state="final">\n        <xlf:source>Knock',
          'state="translated">\n        <xlf:source>Knock',
        ),
      ).toBe(plain);
    });

    it('does not lower a final that arrived, nor touch a translated one that is not confirmed', () => {
      const { file, segments } = persisted('prefilled.en-de.xlf');
      const out = exportFileBytes(file, segments, { reviewedState: true });
      expect(Buffer.from(out.bytes).equals(Buffer.from(file.originalBlob))).toBe(true);
    });

    it('is a no-op for a confirmed segment the file already calls final, so the export stays the original', () => {
      const { file, segments } = persisted('prefilled.en-de.xlf');
      const edited = segments.map((s, i) =>
        i === 2 ? { ...s, status: 'confirmed' as const } : s,
      );
      const out = exportFileBytes(file, edited, { reviewedState: true });
      expect(Buffer.from(out.bytes).equals(Buffer.from(file.originalBlob))).toBe(true);
    });

    it('leaves a draft as initial even when asked', () => {
      const { file, segments } = persisted('prefilled.en-de.xlf');
      const out = decode(exportFileBytes(file, segments, { reviewedState: true }).bytes);
      expect(states(out)[1]).toBe('initial');
    });
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

/**
 * The software-strings fixture (backlog Epic 16, planning/software-localisation-spec.md
 * section 5, slice S0): a catalogue's keys as XLIFF, in the shape the workbench's exporter
 * writes. Invented strings; **not the output of any tool**, so these prove the filter agrees
 * with the shape the spec describes and nothing more.
 */
describe('the software-strings fixture (en to uk)', () => {
  const NAME = 'software-strings.en-uk.xlf';

  it('a zero-edit export is the original, byte for byte', () => {
    const { file, segments } = persisted(NAME, EN_UK);
    const { bytes } = exportFileBytes(file, segments);
    expect(Buffer.from(bytes).equals(Buffer.from(file.originalBlob))).toBe(true);
  });

  it("reads each unit's key and notes (issue #351), and never the file's own note", () => {
    const { assembled } = persisted(NAME, EN_UK);
    const byKey = new Map(assembled.segments.map((s) => [s.unitName, s.unitNotes]));
    expect(byKey.get('saveButton')).toBe(
      'Button, toolbar of the plant page. Imperative verb.',
    );
    expect(byKey.get('itemCount_few')).toBe(
      'Plural, category "few" in Ukrainian (2 to 4, 22 to 24, not 12 to 14).',
    );
    expect(assembled.segments.map((s) => s.unitName)).toEqual([
      'saveButton',
      'cancelButton',
      'welcomeBack',
      'itemCount_one',
      'itemCount_few',
      'itemCount_many',
      'itemCount_other',
      'productName',
      'bandUnlikely',
      'emptyState',
    ]);
    // The file-level `<note category="checksum">` belongs to the file, not to any unit.
    expect(
      assembled.segments.some((s) => (s.unitNotes ?? '').includes('0000000000')),
    ).toBe(false);
  });

  it('records the group a unit sits in, the innermost one, and null outside any (issue #353)', () => {
    const { assembled } = persisted(NAME, EN_UK);
    expect(assembled.segments.map((s) => s.unitGroup)).toEqual([
      null,
      null,
      null,
      'itemCount',
      'itemCount',
      'itemCount',
      'itemCount',
      null,
      null,
      null,
    ]);
    const nested = `<?xml version="1.0"?>
<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="en" trgLang="uk">
  <file id="f">
    <group id="outer">
      <unit id="a"><segment><source>A</source></segment></unit>
      <group id="inner">
        <unit id="b"><segment><source>B</source></segment></unit>
      </group>
      <unit id="c"><segment><source>C</source></segment></unit>
    </group>
    <unit id="d"><segment><source>D</source></segment></unit>
  </file>
</xliff>`;
    expect(
      assembleXliff(new TextEncoder().encode(nested), EN_UK).segments.map(
        (s) => s.unitGroup,
      ),
    ).toEqual(['outer', 'inner', 'outer', null]);
  });

  it('keeps a unit with no name and no notes as null, several notes one per line', () => {
    const xml = `<?xml version="1.0"?>
<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="en" trgLang="uk">
  <file id="f">
    <unit id="a"><segment><source>Open</source></segment></unit>
    <unit id="b" name="statusOpen">
      <notes>
        <note>An adjective: the ticket is open.</note>
        <note>  Two
          lines &amp; <b>markup</b>  </note>
        <note>   </note>
      </notes>
      <segment><source>Open</source></segment>
    </unit>
  </file>
</xliff>`;
    const { segments } = assembleXliff(new TextEncoder().encode(xml), EN_UK);
    expect(segments[0]!.unitName).toBeNull();
    expect(segments[0]!.unitNotes).toBeNull();
    expect(segments[1]!.unitName).toBe('statusOpen');
    expect(segments[1]!.unitNotes).toBe(
      'An adjective: the ticket is open.\nTwo lines & markup',
    );
    // Two units, one source text: the context never enters the hash, so it never splits a repeat.
    expect(segments[0]!.sourceHash).toBe(segments[1]!.sourceHash);
  });

  it('joins notes one per line and collapses whitespace inside a note', () => {
    expect(joinNotes([])).toBeNull();
    expect(joinNotes([' ', ''])).toBeNull();
    expect(joinNotes(['a\n b', 'c'])).toBe('a b\nc');
  });

  it('makes one segment per unit, a plural group included, in document order', () => {
    const { assembled } = persisted(NAME, EN_UK);
    expect(assembled.segments.map((s) => plainText(s.sourceTokens))).toEqual([
      'Save',
      'Cancel',
      // A <ph> is a placeholder token, and plainText leaves a placeholder out: the variable
      // is not in the plain text a glossary, a QA rule or a memory's text index reads.
      'Welcome back, .',
      ' item',
      ' items',
      ' items',
      ' items',
      'Garden Ledger',
      'unlikely',
      'Nothing to show yet.',
    ]);
    // A group does not merge its units: each category keeps its own segment (para_key).
    expect(new Set(assembled.segments.map((s) => s.paraKey)).size).toBe(10);
  });

  it('keeps every {{variable}} as one placeholder token, the same in source and target', () => {
    const { assembled } = persisted(NAME, EN_UK);
    const placeholders = (tokens: readonly Token[]) =>
      tokens.filter((t) => t.t === 'ph').length;
    const withVariable = assembled.segments.filter((x) =>
      x.sourceTokens.some((t) => t.t === 'ph'),
    );
    expect(withVariable).toHaveLength(5);
    for (const s of withVariable) {
      expect(placeholders(s.sourceTokens)).toBe(1);
      expect(placeholders(s.targetTokens ?? [])).toBe(1);
    }
  });

  it('reads the arriving targets as drafts (initial) or translated, a locked unit as locked and an absent one as new', () => {
    const { assembled } = persisted(NAME, EN_UK);
    expect(assembled.segments.map((s) => [plainText(s.sourceTokens), s.status])).toEqual([
      ['Save', 'draft'],
      ['Cancel', 'translated'],
      ['Welcome back, .', 'draft'],
      [' item', 'draft'],
      [' items', 'draft'],
      [' items', 'draft'],
      [' items', 'draft'],
      // A locked unit's arriving target is kept and the segment is locked, never a draft.
      ['Garden Ledger', 'locked'],
      ['unlikely', 'locked'],
      ['Nothing to show yet.', 'new'],
    ]);
  });

  it('gives the plural siblings that share an English form one source hash (the mechanism behind H2)', () => {
    const { assembled } = persisted(NAME, EN_UK);
    const hash = (i: number) => assembled.segments[i]!.sourceHash;
    // few, many and other are all "{{count}} items": identical source, so a memory hit or a
    // propagation donor for one is a hit for the others, in a language where they differ.
    expect(new Set([hash(4), hash(5), hash(6)]).size).toBe(1);
    expect(hash(3)).not.toBe(hash(4));
  });

  it('locks the product name and the fixed scale word (translate="no") and nothing else', () => {
    const { assembled } = persisted(NAME, EN_UK);
    expect(
      assembled.segments.filter((s) => s.locked).map((s) => plainText(s.sourceTokens)),
    ).toEqual(['Garden Ledger', 'unlikely']);
  });

  it('writes a new target into the empty unit and the result reads back, the rest untouched', () => {
    const { file, segments } = persisted(NAME, EN_UK);
    const last = segments.length - 1;
    const edited = segments.map((s, i) =>
      i === last
        ? {
            ...s,
            status: 'confirmed' as const,
            targetTokens: [{ t: 'text', v: 'Поки що нічого показувати.' } as Token],
          }
        : s,
    );
    const out = exportFileBytes(file, edited).bytes;
    const text = decode(out);
    expect(text).toContain('Поки що нічого показувати.');
    // Only that segment's text changed: removing the new target gives back the original.
    expect(
      text.replace(/\s*<target>Поки що нічого показувати\.<\/target>/, ''),
    ).toContain('<source>Nothing to show yet.</source>');
    const again = readXliff(out);
    expect(again.segments).toHaveLength(segments.length);
    expect(() => assembleXliff(out, EN_UK)).not.toThrow();
  });
});
