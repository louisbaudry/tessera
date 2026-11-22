import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { DocxError, readXlsx } from '../docx/package.js';
import { LINE_BREAK_OPEN, plainText, type Token } from '../model/token.js';
import {
  cellStrings,
  importXlsx,
  sheetOrder,
  tableLockedRanges,
  xlsxSegments,
} from './document.js';
import { renderXlsxTokens } from './render.js';
import { hasMeaningfulRunProps, tokenizeXlsxRegion } from './tokenize.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/xlsx',
);
const load = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

/** The fixture with some parts rewritten or removed (`null`). */
function altered(
  name: string,
  change: Record<string, ((xml: string) => string) | null>,
): Uint8Array {
  const entries = unzipSync(load(name));
  for (const [part, fn] of Object.entries(change)) {
    if (fn === null) delete entries[part];
    else entries[part] = encode(fn(decode(entries[part]!)));
  }
  return zipSync(entries);
}

const FONT = '<sz val="11"/><rFont val="Calibri"/>';
const shape = (tokens: readonly Token[]): string =>
  tokens.map((t) => (t.t === 'text' ? JSON.stringify(t.v) : `${t.t}${t.id}`)).join(' ');

describe('tokenizeXlsxRegion', () => {
  it('reads a plain string as its text', () => {
    const region = tokenizeXlsxRegion('<t>Soup of the day</t>');
    expect(region.tokens).toEqual([{ t: 'text', v: 'Soup of the day' }]);
    expect(region.formats).toEqual([]);
  });

  it('decodes entities and character references', () => {
    expect(
      plainText(
        tokenizeXlsxRegion('<t>Bread &amp; butter &lt;fresh&gt; &#233;</t>').tokens,
      ),
    ).toBe('Bread & butter <fresh> é');
  });

  it('makes a run with properties a tag pair, shown only when it is formatting', () => {
    const region = tokenizeXlsxRegion(
      `<r><t xml:space="preserve">Served </t></r>` +
        `<r><rPr><b/>${FONT}</rPr><t>hot</t></r>` +
        `<r><rPr>${FONT}</rPr><t xml:space="preserve"> or cold.</t></r>`,
    );
    // The run with no properties is plain text; the other two are pairs.
    expect(shape(region.tokens)).toBe(
      '"Served " open1 "hot" close1 open2 " or cold." close2',
    );
    expect(region.formats).toEqual([
      {
        id: 1,
        kind: 'b',
        visible: true,
        placement: 'run',
        open: `<r><rPr><b/>${FONT}</rPr>`,
        close: '</r>',
      },
      {
        id: 2,
        kind: 'other',
        visible: false,
        placement: 'run',
        open: `<r><rPr>${FONT}</rPr>`,
        close: '</r>',
      },
    ]);
  });

  it('reads a property that is switched off as off, and the spelled-out true as on', () => {
    expect(hasMeaningfulRunProps('<rPr><b val="0"/><sz val="11"/></rPr>')).toBe(false);
    expect(hasMeaningfulRunProps('<rPr><i val="false"/></rPr>')).toBe(false);
    expect(hasMeaningfulRunProps('<rPr><u val="none"/></rPr>')).toBe(false);
    // What LibreOffice writes.
    expect(hasMeaningfulRunProps('<rPr><b val="true"/><sz val="10"/></rPr>')).toBe(true);
    expect(hasMeaningfulRunProps('<rPr><u/></rPr>')).toBe(true);
    expect(hasMeaningfulRunProps('<rPr><strike/></rPr>')).toBe(true);
    // Font, size and colour alone are not formatting a translator places.
    expect(
      hasMeaningfulRunProps(
        '<rPr><sz val="11"/><color theme="1"/><rFont val="A"/></rPr>',
      ),
    ).toBe(false);
    // `<b` must not be found in `<border…>` or the like.
    expect(hasMeaningfulRunProps('<rPr><bogus/><icon/></rPr>')).toBe(false);
  });

  it('names the kind by what the run does', () => {
    const kindOf = (props: string) =>
      tokenizeXlsxRegion(`<r><rPr>${props}</rPr><t>x</t></r>`).formats[0]!.kind;
    expect(kindOf('<i/>')).toBe('i');
    expect(kindOf('<u/>')).toBe('u');
    expect(kindOf('<strike/>')).toBe('strike');
    expect(kindOf('<vertAlign val="superscript"/>')).toBe('sup');
    expect(kindOf('<vertAlign val="subscript"/><b/>')).toBe('sub');
    expect(kindOf('<sz val="9"/>')).toBe('other');
  });

  it('makes a line break in a cell a visible placeholder, however it is written', () => {
    for (const xml of [
      '<t xml:space="preserve">First line\nSecond line</t>',
      '<t xml:space="preserve">First line&#10;Second line</t>',
      '<t xml:space="preserve">First line\r\nSecond line</t>',
    ]) {
      const region = tokenizeXlsxRegion(xml);
      expect(shape(region.tokens)).toBe('"First line" ph1 "Second line"');
      expect(region.formats).toEqual([
        {
          id: 1,
          kind: 'br',
          visible: true,
          placement: 'in-run',
          open: LINE_BREAK_OPEN,
          close: '',
        },
      ]);
    }
  });

  it('keeps a line break inside its run', () => {
    const region = tokenizeXlsxRegion('<r><rPr><b/></rPr><t>one\ntwo</t></r>');
    expect(shape(region.tokens)).toBe('open1 "one" ph2 "two" close1');
  });

  it('leaves the phonetic guide out: it is a reading of the source', () => {
    const region = tokenizeXlsxRegion(
      '<t>Tokyo office</t><rPh sb="0" eb="5"><t>toukyou</t></rPh><phoneticPr fontId="1"/>',
    );
    expect(region.tokens).toEqual([{ t: 'text', v: 'Tokyo office' }]);
    expect(region.formats).toEqual([]);
  });

  it('keeps whole, and hidden, a run with no text and an element it does not know', () => {
    const empty = '<r><rPr><b/></rPr><t/></r>';
    const region = tokenizeXlsxRegion(`<r><t>a</t></r>${empty}<mystery val="1"/>`);
    expect(shape(region.tokens)).toBe('"a" ph1 ph2');
    expect(region.formats.map((f) => [f.visible, f.placement, f.open])).toEqual([
      [false, 'block', empty],
      [false, 'block', '<mystery val="1"/>'],
    ]);
  });
});

describe('renderXlsxTokens', () => {
  const roundtrip = (xml: string): string => {
    const region = tokenizeXlsxRegion(xml);
    return renderXlsxTokens(region.tokens, region.formats);
  };

  it('writes a string that is only text as one bare t', () => {
    expect(renderXlsxTokens([{ t: 'text', v: 'Suppe' }], [])).toBe('<t>Suppe</t>');
    // Two sentences folded back are still one text node: a string holds one.
    expect(
      renderXlsxTokens(
        [
          { t: 'text', v: 'Eins.' },
          { t: 'text', v: ' Zwei.' },
        ],
        [],
      ),
    ).toBe('<t>Eins. Zwei.</t>');
  });

  it('escapes text, and asks for whitespace to be kept where it would be lost', () => {
    expect(renderXlsxTokens([{ t: 'text', v: 'a & b < c' }], [])).toBe(
      '<t>a &amp; b &lt; c</t>',
    );
    expect(renderXlsxTokens([{ t: 'text', v: '  Padded  ' }], [])).toBe(
      '<t xml:space="preserve">  Padded  </t>',
    );
    expect(renderXlsxTokens([{ t: 'text', v: 'two  spaces' }], [])).toBe(
      '<t xml:space="preserve">two  spaces</t>',
    );
  });

  it('writes a line break back as the character, inside the one text node', () => {
    expect(roundtrip('<t xml:space="preserve">First line&#10;Second line</t>')).toBe(
      '<t xml:space="preserve">First line\nSecond line</t>',
    );
    // Inside a run too: a run still holds exactly one t.
    expect(roundtrip('<r><rPr><b/></rPr><t>one\ntwo</t></r>')).toBe(
      '<r><rPr><b/></rPr><t xml:space="preserve">one\ntwo</t></r>',
    );
  });

  it('gives bare text a run of its own as soon as the string holds runs', () => {
    // A string is one t or runs, never a t beside runs.
    expect(
      roundtrip(
        `<r><t xml:space="preserve">Served </t></r><r><rPr><b/>${FONT}</rPr><t>hot</t></r>`,
      ),
    ).toBe(
      `<r><t xml:space="preserve">Served </t></r><r><rPr><b/>${FONT}</rPr><t>hot</t></r>`,
    );
  });

  it('renders a rich string back as it was tokenized', () => {
    const xml =
      `<r><rPr><i/>${FONT}</rPr><t>Note</t></r>` +
      `<r><rPr><vertAlign val="superscript"/>${FONT}</rPr><t>1</t></r>` +
      `<r><t xml:space="preserve"> applies.</t></r>`;
    expect(roundtrip(xml)).toBe(xml);
  });

  it('drops the phonetic guide from a string that is rendered', () => {
    expect(
      roundtrip(
        '<t>Tokyo office</t><rPh sb="0" eb="5"><t>toukyou</t></rPh><phoneticPr fontId="1"/>',
      ),
    ).toBe('<t>Tokyo office</t>');
  });

  it('writes a target that kept none of the runs as plain text', () => {
    const { formats } = tokenizeXlsxRegion('<r><rPr><b/></rPr><t>Bold</t></r>');
    expect(renderXlsxTokens([{ t: 'text', v: 'Fett' }], formats)).toBe('<t>Fett</t>');
  });
});

describe('cellStrings', () => {
  it('lists the strings a sheet shows, in document order, each with its place', () => {
    const xml =
      '<worksheet><sheetData><row r="1">' +
      '<c r="A1" t="s"><v>5</v></c>' +
      '<c r="B1" s="2" t="s"><v> 2 </v></c>' +
      // A number is not an index, and neither is a formula's cached text.
      '<c r="C1"><v>7</v></c>' +
      '<c r="D1" t="str"><f>A1&amp;"!"</f><v>Served!</v></c>' +
      '<c r="E1" t="inlineStr"><is><t>Inline</t></is></c>' +
      '</row><row r="2">' +
      // A self-closed string cell opens nothing: the 9 after it is a number.
      '<c r="A2" t="s"/><c r="B2"><v>9</v></c>' +
      '<c r="C2" t="inlineStr"><is><r><t>Rich</t></r></is></c>' +
      // No reference: the cell after C2 is D2.
      '<c t="s"><v>1</v></c>' +
      '</row></sheetData></worksheet>';
    expect(cellStrings(xml)).toEqual([
      { col: 1, row: 1, shared: 5 },
      { col: 2, row: 1, shared: 2 },
      { col: 5, row: 1, inline: 0 },
      { col: 3, row: 2, inline: 1 },
      { col: 4, row: 2, shared: 1 },
    ]);
  });

  it('places a cell with no reference by its order, and a row with no number after the last', () => {
    const xml =
      '<worksheet><sheetData>' +
      '<row><c t="s"><v>0</v></c><c/><c t="s"><v>1</v></c></row>' +
      // A row that says it is the fifth, then one that says nothing: the sixth.
      '<row r="5"><c r="C5" t="s"><v>2</v></c><c t="s"><v>3</v></c></row>' +
      '<row><c t="inlineStr"><is><t>x</t></is></c></row>' +
      // An empty self-closed row still counts as a row.
      '<row/><row><c t="s"><v>4</v></c></row>' +
      '</sheetData></worksheet>';
    expect(cellStrings(xml)).toEqual([
      { col: 1, row: 1, shared: 0 },
      { col: 3, row: 1, shared: 1 },
      { col: 3, row: 5, shared: 2 },
      { col: 4, row: 5, shared: 3 },
      { col: 1, row: 6, inline: 0 },
      { col: 1, row: 8, shared: 4 },
    ]);
  });

  it('is not misled by elements whose names begin like a cell or a row', () => {
    const xml =
      '<worksheet><cols><col min="1" max="1" width="9"/></cols><sheetData><row r="1">' +
      '<c r="A1" t="s"><v>0</v></c></row></sheetData>' +
      '<conditionalFormatting sqref="A1"><cfRule type="cellIs" priority="1"/></conditionalFormatting>' +
      '<rowBreaks count="1"><brk id="1"/></rowBreaks>' +
      '</worksheet>';
    expect(cellStrings(xml)).toEqual([{ col: 1, row: 1, shared: 0 }]);
  });
});

describe('sheetOrder', () => {
  it('follows the workbook, not the file numbers', () => {
    // The fixture's first tab is sheet2.xml.
    expect(sheetOrder(readXlsx(load('edge-cases.en.xlsx')))).toEqual([
      'xl/worksheets/sheet2.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet3.xml',
    ]);
  });

  it('falls back to the file numbers when the order cannot be read', () => {
    const pkg = readXlsx(
      altered('edge-cases.en.xlsx', { 'xl/_rels/workbook.xml.rels': null }),
    );
    expect(sheetOrder(pkg)).toEqual([
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
      'xl/worksheets/sheet3.xml',
    ]);
  });
});

describe('tableLockedRanges', () => {
  it("names a table's header row and its totals row", () => {
    const pkg = readXlsx(load('edge-cases.en.xlsx'));
    // Table1 is A1:B4 with one header row and one totals row.
    expect(tableLockedRanges(pkg, 'xl/worksheets/sheet2.xml')).toEqual([
      { col1: 1, row1: 1, col2: 2, row2: 1 },
      { col1: 1, row1: 4, col2: 2, row2: 4 },
    ]);
    expect(tableLockedRanges(pkg, 'xl/worksheets/sheet1.xml')).toEqual([]);
  });

  it('names no header row for a table that says it has none', () => {
    const pkg = readXlsx(
      altered('edge-cases.en.xlsx', {
        'xl/tables/table1.xml': (xml) =>
          xml.replace('totalsRowCount="1"', 'headerRowCount="0"'),
      }),
    );
    expect(tableLockedRanges(pkg, 'xl/worksheets/sheet2.xml')).toEqual([]);
  });
});

describe('xlsxSegments', () => {
  const segments = xlsxSegments(importXlsx(load('edge-cases.en.xlsx')));

  it('lists strings where a cell first shows them: tab by tab, row by row', () => {
    expect(segments.map((s) => s.text)).toEqual([
      // Menu (sheet2.xml, the first tab)
      'Dish',
      'Price',
      'Soup of the day',
      'Bread & butter <fresh>',
      'Total',
      // Orders (sheet1.xml): "Soup of the day" and "Price" were already met.
      'Served hot or cold. Ask the kitchen.',
      'First line\nSecond line',
      '2026',
      // Notes (sheet3.xml): shared and inline strings as the rows hold them.
      'Tokyo office',
      'Inline note.',
      'Note1 applies.',
      'Bold inline and plain.',
      '  Padded  ',
      'Not bold at all.',
      'Kept_x000D_\nraw.',
    ]);
  });

  it('names the part and the string each segment came from', () => {
    const at = (text: string) => {
      const s = segments.find((x) => x.text === text)!;
      return `${s.part}#${s.key}`;
    };
    expect(at('Dish')).toBe('xl/sharedStrings.xml#s1');
    expect(at('Tokyo office')).toBe('xl/sharedStrings.xml#s11');
    expect(at('Inline note.')).toBe('xl/worksheets/sheet3.xml#s1');
    expect(at('Bold inline and plain.')).toBe('xl/worksheets/sheet3.xml#s2');
    expect(segments.map((s) => s.ord)).toEqual(segments.map((_, i) => i));
  });

  it('leaves out a string no cell shows, and an empty one', () => {
    const texts = segments.map((s) => s.text);
    expect(texts).not.toContain('Unused text nobody sees.');
    expect(texts).not.toContain('');
  });

  it("locks a table's header and totals rows, and text with no letter", () => {
    expect(segments.filter((s) => s.untranslatable).map((s) => s.text)).toEqual([
      // "Price" is also an ordinary cell on another sheet: one string, so locked there too.
      'Dish',
      'Price',
      'Total',
      '2026',
    ]);
  });

  it('does not read a phonetic guide as text', () => {
    expect(segments.some((s) => s.text.includes('toukyou'))).toBe(false);
  });

  it('locks a header whose cells do not say where they are', () => {
    // A cell's reference and a row's number are optional: the position is then the
    // cell's place in its row, and the row's among the rows.
    const implicit = xlsxSegments(
      importXlsx(
        altered('edge-cases.en.xlsx', {
          'xl/worksheets/sheet2.xml': (xml) => xml.replace(/<(row|c) r="[^"]*"/g, '<$1'),
        }),
      ),
    );
    expect(implicit.filter((s) => s.untranslatable).map((s) => s.text)).toEqual([
      'Dish',
      'Price',
      'Total',
      '2026',
    ]);
  });

  it('translates a header again once the table says it has no header row', () => {
    const open = xlsxSegments(
      importXlsx(
        altered('edge-cases.en.xlsx', {
          'xl/tables/table1.xml': (xml) =>
            xml.replace('totalsRowCount="1"', 'headerRowCount="0"'),
        }),
      ),
    );
    expect(open.filter((s) => s.untranslatable).map((s) => s.text)).toEqual(['2026']);
  });
});

describe('importXlsx', () => {
  it('keeps a skeleton only for the parts that hold strings', () => {
    expect(importXlsx(load('edge-cases.en.xlsx')).skeletons.map((s) => s.part)).toEqual([
      'xl/sharedStrings.xml',
      'xl/worksheets/sheet3.xml',
    ]);
    expect(importXlsx(load('lo-book.en.xlsx')).skeletons.map((s) => s.part)).toEqual([
      'xl/sharedStrings.xml',
    ]);
  });

  it('reads a workbook with no shared strings at all', () => {
    const doc = importXlsx(
      altered('edge-cases.en.xlsx', {
        'xl/sharedStrings.xml': null,
        'xl/_rels/workbook.xml.rels': (xml) =>
          xml.replace(/<Relationship Id="rId5"[^>]*\/>/, ''),
      }),
    );
    expect(xlsxSegments(doc).map((s) => s.text)).toEqual([
      'Inline note.',
      'Bold inline and plain.',
    ]);
  });

  it('refuses what is not a workbook', () => {
    expect(() => importXlsx(encode('not a zip'))).toThrow(DocxError);
    expect(() =>
      importXlsx(altered('edge-cases.en.xlsx', { 'xl/workbook.xml': null })),
    ).toThrow(/missing required part: xl\/workbook\.xml/);
  });

  it('refuses a workbook written with a namespace prefix, by name', () => {
    // Read without a prefix, such a file would import as no text at all.
    const prefixed = altered('edge-cases.en.xlsx', {
      'xl/sharedStrings.xml': (xml) =>
        xml
          .replace('<sst xmlns=', '<x:sst xmlns:x=')
          .replace('</sst>', '</x:sst>')
          .replace(/<(\/?)(si|t|r|rPr)\b/g, '<$1x:$2'),
    });
    expect(() => importXlsx(prefixed)).toThrow(DocxError);
    expect(() => importXlsx(prefixed)).toThrow(/namespace prefix \(<x:sst>\)/);
  });

  it('refuses shared strings kept somewhere it cannot name', () => {
    const entries = unzipSync(load('edge-cases.en.xlsx'));
    entries['xl/strings/shared.xml'] = entries['xl/sharedStrings.xml']!;
    delete entries['xl/sharedStrings.xml'];
    entries['xl/_rels/workbook.xml.rels'] = encode(
      decode(entries['xl/_rels/workbook.xml.rels']!).replace(
        'Target="sharedStrings.xml"',
        'Target="strings/shared.xml"',
      ),
    );
    expect(() => importXlsx(zipSync(entries))).toThrow(
      /shared strings at xl\/strings\/shared\.xml/,
    );
  });
});
