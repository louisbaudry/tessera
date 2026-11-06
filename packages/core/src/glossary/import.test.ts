import { describe, expect, it } from 'vitest';

import { MAX_GLOSSARY_IMPORT_ROWS, parseGlossaryCsv } from './import.js';

const HEADER = 'term,lang,rendering,status,avoid,keep';

function messages(text: string, srcLang = 'en'): string[] {
  return parseGlossaryCsv(text, srcLang).refusals.map((r) => `${r.line}: ${r.message}`);
}

describe('parseGlossaryCsv', () => {
  it('reads a row with every column', () => {
    const { rows, refusals } = parseGlossaryCsv(
      `${HEADER}\nsource,uk,джерело,official,"джерела | першоджерело",no\n`,
      'en',
    );
    expect(refusals).toEqual([]);
    expect(rows).toEqual([
      {
        line: 2,
        term: 'source',
        lang: 'uk',
        rendering: 'джерело',
        status: 'official',
        avoid: ['джерела', 'першоджерело'],
        keep: false,
      },
    ]);
  });

  it('takes the columns in any order and the optional ones as absent', () => {
    const { rows } = parseGlossaryCsv(
      'rendering,lang,term\r\nfactura,es,invoice\r\n',
      'en',
    );
    expect(rows).toEqual([
      {
        line: 2,
        term: 'invoice',
        lang: 'es',
        rendering: 'factura',
        status: 'official',
        avoid: [],
        keep: false,
      },
    ]);
  });

  it('reads quoted cells with a comma, a doubled quote and a line break, and counts lines through them', () => {
    const { rows, refusals } = parseGlossaryCsv(
      `${HEADER}\n"a, b",uk,"x ""y""\nz",review,,\nsecond,uk,другий,,,\n`,
      'en',
    );
    expect(refusals).toEqual([]);
    expect(rows[0]).toMatchObject({
      term: 'a, b',
      rendering: 'x "y"\nz',
      status: 'review',
      line: 2,
    });
    expect(rows[1]).toMatchObject({ term: 'second', line: 4 });
  });

  it('reads a BOM and a file with no final newline', () => {
    const { rows } = parseGlossaryCsv(`﻿term,lang,rendering\nsource,uk,джерело`, 'en');
    expect(rows).toHaveLength(1);
  });

  it('makes a keep row a rendering equal to the term', () => {
    const { rows } = parseGlossaryCsv(
      `${HEADER}\nOSINT,uk,,official,,yes\nTelegram,ru,telegram,,,true\n`,
      'en',
    );
    expect(rows.map((r) => [r.rendering, r.keep])).toEqual([
      ['OSINT', true],
      ['Telegram', true],
    ]);
  });

  describe('refuses, naming the line', () => {
    it.each([
      ['an empty file', '', ['0: the file is empty']],
      ['a header alone', `${HEADER}\n`, ['0: the file has a header and no rows']],
      [
        'a missing required column',
        'term,rendering\nsource,x\n',
        ['1: the header has no "lang" column'],
      ],
      [
        'an unknown and a repeated column',
        'term,lang,rendering,colour,term\na,uk,b\n',
        ['1: unknown column "colour"', '1: column "term" appears twice'],
      ],
      [
        'a short row',
        `${HEADER}\nsource,uk,джерело\n`,
        ['2: 3 cells where the header has 6'],
      ],
      ['an empty term', `${HEADER}\n,uk,x,,,\n`, ['2: the term is empty']],
      ['an empty rendering', `${HEADER}\nsource,uk,,,,\n`, ['2: the rendering is empty']],
      [
        'a malformed language',
        `${HEADER}\nsource,u k,x,,,\n`,
        ['2: "u k" is not a language tag'],
      ],
      [
        'the source language as the target',
        `${HEADER}\nsource,en-GB,x,,,\n`,
        ['2: "en-GB" is the source language, and a term is not its own rendering'],
      ],
      [
        'an unknown status',
        `${HEADER}\nsource,uk,x,draft,,\n`,
        ['2: status "draft" is neither official nor review'],
      ],
      [
        'an unreadable flag',
        `${HEADER}\nsource,uk,x,,,maybe\n`,
        ['2: keep "maybe" is neither yes nor no'],
      ],
      [
        'keep with another rendering',
        `${HEADER}\nsource,uk,джерело,,,yes\n`,
        ['2: keep means the rendering is the term itself, and this one differs'],
      ],
      [
        'an avoided rendering that is the rendering',
        `${HEADER}\nsource,uk,джерело,,Джерело,\n`,
        ['2: "Джерело" is both the rendering and a rendering to avoid'],
      ],
      [
        'a second rendering of one term in one language',
        `${HEADER}\nSource,uk,a,,,\nother,uk,b,,,\nsource,uk-UA,c,,,\n`,
        ['4: the term already has a rendering in uk-UA on line 2'],
      ],
      [
        'a quote in the middle of a cell',
        `${HEADER}\nso"urce,uk,x,,,\n`,
        ['2: a quote inside a cell that does not start with one'],
      ],
      [
        'text after a closing quote',
        `${HEADER}\n"a"b,uk,x,,,\n`,
        ['2: text after the closing quote of a cell'],
      ],
      [
        'an unclosed quote',
        `${HEADER}\n"a,uk,x,,,\n`,
        ['2: a quote is opened and never closed'],
      ],
    ])('%s', (_name, text, expected) => {
      const parsed = parseGlossaryCsv(text, 'en');
      expect(parsed.refusals.map((r) => `${r.line}: ${r.message}`)).toEqual(expected);
      expect(parsed.rows).toEqual([]);
    });

    it('reports every bad line, not only the first, and no rows with it', () => {
      const parsed = parseGlossaryCsv(
        `${HEADER}\nok,uk,добре,,,\n,uk,x,,,\nbad,u k,y,,,\n`,
        'en',
      );
      expect(parsed.refusals.map((r) => r.line)).toEqual([3, 4]);
      expect(parsed.rows).toEqual([]);
    });

    it('refuses a bad source language and a file of too many rows', () => {
      expect(messages(`${HEADER}\na,uk,b,,,\n`, '??')).toEqual([
        '0: "??" is not a language tag',
      ]);
      const many = `term,lang,rendering\n${Array.from(
        { length: MAX_GLOSSARY_IMPORT_ROWS + 1 },
        (_, i) => `t${i},uk,r${i}`,
      ).join('\n')}\n`;
      expect(messages(many)[0]).toMatch(/^0: 20001 rows is more than one import takes/);
    });
  });
});
