import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ProjectFile } from '../docx/document.js';
import { getPart, readXlsx } from '../docx/package.js';
import { scanChildren, scanElements } from '../docx/xml-scan.js';
import type { Segment } from '../model/segment.js';
import { plainText, type Token } from '../model/token.js';
import { rulesFor } from '../segment/rules.js';
import { cellStrings, importXlsx, xlsxSegments } from '../xlsx/document.js';
import { assembleNamed, assembleXlsx, type AssembledFile } from './assemble.js';
import { exportFileBytes } from './export-any.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/xlsx',
);
const load = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function persisted(name: string): {
  file: ProjectFile;
  segments: Segment[];
  assembled: AssembledFile;
} {
  const assembled = assembleXlsx(load(name), rulesFor('en'));
  const file: ProjectFile = {
    id: 7,
    kind: 'xlsx',
    relPath: name,
    originalBlob: assembled.originalBlob,
    skeleton: assembled.skeleton,
    partMap: assembled.partMap,
    importedAt: '2026-11-22T00:00:00.000Z',
  };
  const segments = assembled.segments.map((s, i): Segment => ({
    id: i + 1,
    fileId: 7,
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
    updatedAt: '2026-11-22T00:00:00.000Z',
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

/**
 * What the schema asks of every string of a part: one bare `t` and no run, or
 * runs only, each holding at most one `rPr` and exactly one `t` (then, in a
 * string nobody rendered, the phonetic guide).
 */
function expectWellFormedStrings(xml: string, element: 'si' | 'is'): void {
  for (const el of scanElements(xml, new Set([element]))) {
    const names = scanChildren(xml, el.contentStart, el.contentEnd).map((c) => c.name);
    const text = names.filter((n) => n === 't').length;
    const runs = names.filter((n) => n === 'r').length;
    const where = xml.slice(el.start, el.end);
    expect(text <= 1, where).toBe(true);
    expect(text === 0 || runs === 0, where).toBe(true);
    // Order: text or runs first, the phonetic guide after them.
    const firstPhonetic = names.findIndex((n) => n === 'rPh' || n === 'phoneticPr');
    if (firstPhonetic !== -1) {
      expect(
        names.slice(firstPhonetic).every((n) => n === 'rPh' || n === 'phoneticPr'),
        where,
      ).toBe(true);
    }
    for (const run of scanChildren(xml, el.contentStart, el.contentEnd)) {
      if (run.name !== 'r') continue;
      const inside = scanChildren(xml, run.contentStart, run.contentEnd).map(
        (c) => c.name,
      );
      expect(inside.join(','), where).toMatch(/^(rPr,)?t$/);
    }
  }
}

describe('assembleXlsx', () => {
  it('stores the strings in reading order under strings and sheet<n>', () => {
    const { assembled } = persisted('edge-cases.en.xlsx');
    expect(assembled.kind).toBe('xlsx');
    expect(assembled.partMap).toEqual([
      'xl/sharedStrings.xml',
      'xl/worksheets/sheet3.xml',
    ]);
    expect(assembled.segments.map((s) => [s.part, plainText(s.sourceTokens)])).toEqual([
      ['strings', 'Dish'],
      ['strings', 'Price'],
      ['strings', 'Soup of the day'],
      ['strings', 'Bread & butter <fresh>'],
      ['strings', 'Total'],
      // One cell, two sentences: two segments of one string.
      ['strings', 'Served hot or cold.'],
      ['strings', ' Ask the kitchen.'],
      ['strings', 'First lineSecond line'],
      ['strings', '2026'],
      ['strings', 'Tokyo office'],
      ['sheet3', 'Inline note.'],
      ['strings', 'Note1 applies.'],
      ['sheet3', 'Bold inline and plain.'],
      ['strings', '  Padded  '],
      ['strings', 'Not bold at all.'],
      ['strings', 'Kept_x000D_raw.'],
    ]);
    expect(assembled.segments.map((s) => s.ord)).toEqual(
      assembled.segments.map((_, i) => i),
    );
  });

  it("locks a table's header and totals rows and text with no letter", () => {
    const { assembled } = persisted('edge-cases.en.xlsx');
    const locked = assembled.segments.filter((s) => s.locked);
    expect(locked.map((s) => plainText(s.sourceTokens))).toEqual([
      'Dish',
      'Price',
      'Total',
      '2026',
    ]);
    expect(locked.every((s) => s.status === 'locked')).toBe(true);
  });

  it('shows a line break as a tag the translator places', () => {
    const { assembled } = persisted('edge-cases.en.xlsx');
    const two = assembled.segments.find(
      (s) => plainText(s.sourceTokens) === 'First lineSecond line',
    )!;
    expect(two.sourceTokens.map((t) => t.t)).toEqual(['text', 'ph', 'text']);
    expect(two.formatTable).toMatchObject([{ kind: 'br', visible: true }]);
  });

  it('is what a name ending in .xlsx picks', () => {
    const byName = assembleNamed('Menu.XLSX', load('edge-cases.en.xlsx'), rulesFor('en'));
    expect(byName.kind).toBe('xlsx');
    expect(byName.segments).toHaveLength(16);
  });

  it("reads LibreOffice's own workbook", () => {
    const { assembled } = persisted('lo-book.en.xlsx');
    const texts = assembled.segments.map((s) => plainText(s.sourceTokens));
    // "Room", "Greenhouse" and "Laboratory" are on both sheets: once each.
    expect(texts.filter((t) => t === 'Greenhouse')).toHaveLength(1);
    expect(texts).toEqual(
      expect.arrayContaining([
        'Session',
        'Bring sturdy boots and a hat.',
        ' The ground is wet in the morning.',
        // LibreOffice writes the cell's line break as a character reference.
        'Meet at the pump.Gloves are provided.',
        "Starts at four o'clock sharp.",
        'Sample jars & labels',
      ]),
    );
    const bold = assembled.segments.find(
      (s) => plainText(s.sourceTokens) === 'Bring sturdy boots and a hat.',
    )!;
    expect(bold.formatTable.filter((f) => f.visible).map((f) => f.kind)).toEqual(['b']);
  });
});

describe('exportFileBytes on an XLSX', () => {
  it('gives back every part byte for byte when nothing was translated', () => {
    for (const name of ['edge-cases.en.xlsx', 'lo-book.en.xlsx']) {
      const { file, segments } = persisted(name);
      const out = readXlsx(exportFileBytes(file, segments).bytes);
      const original = readXlsx(load(name));
      expect(out.parts.map((p) => p.name)).toEqual(original.parts.map((p) => p.name));
      for (const part of original.parts) {
        expect(digest(getPart(out, part.name)!), `${name} :: ${part.name}`).toBe(
          digest(part.data),
        );
      }
    }
  });

  it('writes every translated string where its source was, and well-formed', () => {
    for (const name of ['edge-cases.en.xlsx', 'lo-book.en.xlsx']) {
      const { file, segments } = persisted(name);
      const exported = exportFileBytes(file, translate(segments));
      expect(exported.summary.segmentsWithTarget).toBe(
        segments.filter((s) => !s.locked).length,
      );

      const pkg = readXlsx(exported.bytes);
      expectWellFormedStrings(decode(getPart(pkg, 'xl/sharedStrings.xml')!), 'si');
      for (const part of pkg.parts) {
        if (/^xl\/worksheets\/sheet\d+\.xml$/.test(part.name)) {
          expectWellFormedStrings(decode(part.data), 'is');
        }
      }

      // Read back: every translatable string changed, in the same place.
      const before = xlsxSegments(importXlsx(load(name)));
      const after = xlsxSegments(importXlsx(exported.bytes));
      expect(after.map((s) => `${s.part}#${s.key}`)).toEqual(
        before.map((s) => `${s.part}#${s.key}`),
      );
      before.forEach((s, i) => {
        if (s.untranslatable) expect(after[i]!.text, s.text).toBe(s.text);
        else expect(after[i]!.text, s.text).toContain('Ü');
      });
    }
  });

  it('changes the parts that hold strings and no other', () => {
    const { file, segments } = persisted('edge-cases.en.xlsx');
    const out = readXlsx(exportFileBytes(file, translate(segments)).bytes);
    const original = readXlsx(load('edge-cases.en.xlsx'));
    const changed = original.parts
      .filter((p) => digest(getPart(out, p.name)!) !== digest(p.data))
      .map((p) => p.name);
    // The table, the styles and the two sheets with no inline string are untouched.
    expect(changed).toEqual(['xl/sharedStrings.xml', 'xl/worksheets/sheet3.xml']);
  });

  it("leaves a table's header and totals cells as the table part names them", () => {
    const { file, segments } = persisted('edge-cases.en.xlsx');
    const out = readXlsx(exportFileBytes(file, translate(segments)).bytes);
    const strings = decode(getPart(out, 'xl/sharedStrings.xml')!);
    expect(strings).toContain('<si><t>Dish</t></si>');
    expect(strings).toContain('<si><t>Price</t></si>');
    expect(strings).toContain('<si><t>Total</t></si>');
    const table = decode(getPart(out, 'xl/tables/table1.xml')!);
    expect(table).toContain('name="Dish" totalsRowLabel="Total"');
  });

  it('keeps the cells pointing at the same strings: an index never moves', () => {
    const { file, segments } = persisted('edge-cases.en.xlsx');
    const out = readXlsx(exportFileBytes(file, translate(segments)).bytes);
    const original = readXlsx(load('edge-cases.en.xlsx'));
    for (const sheet of ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
      expect(cellStrings(decode(getPart(out, sheet)!))).toEqual(
        cellStrings(decode(getPart(original, sheet)!)),
      );
    }
    // The string no cell shows, and the empty one, are still in their places.
    const strings = decode(getPart(out, 'xl/sharedStrings.xml')!);
    expect(scanElements(strings, new Set(['si']))).toHaveLength(15);
    expect(strings).toContain('<si><t>Unused text nobody sees.</t></si><si><t/></si>');
  });

  it('writes a string once however many cells show it', () => {
    const { file, segments } = persisted('edge-cases.en.xlsx');
    const soup = segments.filter((s) => plainText(s.sourceTokens) === 'Soup of the day');
    expect(soup).toHaveLength(1);
    const out = readXlsx(
      exportFileBytes(
        file,
        segments.map((s) =>
          s.id === soup[0]!.id
            ? { ...s, targetTokens: [{ t: 'text', v: 'Tagessuppe' }] as Token[] }
            : s,
        ),
      ).bytes,
    );
    const strings = decode(getPart(out, 'xl/sharedStrings.xml')!);
    expect(strings.match(/Tagessuppe/g)).toHaveLength(1);
    expect(strings).not.toContain('Soup of the day');
  });

  it('writes a line break back as the character, and folds two sentences into one string', () => {
    const { file, segments } = persisted('edge-cases.en.xlsx');
    const out = readXlsx(exportFileBytes(file, translate(segments)).bytes);
    const strings = decode(getPart(out, 'xl/sharedStrings.xml')!);
    expect(strings).toContain(
      '<si><t xml:space="preserve">ÜFirst line&amp;&lt;\nÜSecond line&amp;&lt;</t></si>',
    );
    // "Served hot or cold." and " Ask the kitchen." are one string again, its runs kept.
    const rich = /<si><r><t[^>]*>ÜServed [\s\S]*?<\/si>/.exec(strings)?.[0] ?? '';
    expect(rich).toContain('<r><rPr><b/>');
    expect(rich).toContain('Ühot&amp;&lt;');
    expect(rich).toContain('Ü Ask the kitchen.&amp;&lt;');
  });

  it('drops the phonetic guide of a translated string and keeps an untranslated one', () => {
    const { file, segments } = persisted('edge-cases.en.xlsx');
    const translated = decode(
      getPart(
        readXlsx(exportFileBytes(file, translate(segments)).bytes),
        'xl/sharedStrings.xml',
      )!,
    );
    expect(translated).not.toContain('<rPh');
    expect(translated).not.toContain('toukyou');

    const one = segments.map((s) =>
      plainText(s.sourceTokens) === 'Inline note.'
        ? { ...s, targetTokens: [{ t: 'text', v: 'Notiz.' }] as Token[] }
        : s,
    );
    const untouched = decode(
      getPart(readXlsx(exportFileBytes(file, one).bytes), 'xl/sharedStrings.xml')!,
    );
    expect(untouched).toContain('<rPh sb="0" eb="5"><t>toukyou</t></rPh>');
  });

  it('writes a translated inline string into its own cell', () => {
    const { file, segments } = persisted('edge-cases.en.xlsx');
    const one = segments.map((s) =>
      plainText(s.sourceTokens) === 'Inline note.'
        ? { ...s, targetTokens: [{ t: 'text', v: 'Notiz.' }] as Token[] }
        : s,
    );
    const sheet = decode(
      getPart(readXlsx(exportFileBytes(file, one).bytes), 'xl/worksheets/sheet3.xml')!,
    );
    expect(sheet).toContain('<c r="B1" t="inlineStr"><is><t>Notiz.</t></is></c>');
  });
});
