import { describe, expect, it } from 'vitest';

import { numberFormatFor, type NumberFormat } from './locale.js';
import { canonicalValue, compareNumerals, extractNumerals } from './numbers.js';

const EN = numberFormatFor('en');
const FR = numberFormatFor('fr');
const DE = numberFormatFor('de');
const ES = numberFormatFor('es');

const surfaces = (text: string, format = EN) =>
  extractNumerals(text, format).map((n) => n.surface);

describe('extractNumerals', () => {
  it('reads punctuation-grouped numerals whole, whatever the locale', () => {
    expect(surfaces('Total 1,000.50 or 1.000,50 or 3.2.1')).toEqual([
      '1,000.50',
      '1.000,50',
      '3.2.1',
    ]);
  });

  it('reads space-grouped numerals with every whitespace variant', () => {
    expect(surfaces('1 000 ou 1\u00A0000 ou 1\u202F000,50 ou 1\u2009000')).toEqual([
      '1 000',
      '1\u00A0000',
      '1\u202F000,50',
      '1\u2009000',
    ]);
  });

  it('never joins two numbers that merely sit a space apart', () => {
    expect(surfaces('In 2024 500 people came')).toEqual(['2024', '500']);
    expect(surfaces('call 555 1234 now')).toEqual(['555', '1234']);
    expect(surfaces('06 12 34 56 78')).toEqual(['06', '12', '34', '56', '78']);
  });

  it('accepts a Swiss apostrophe as a separator', () => {
    expect(surfaces("CHF 1'000.50 or 2\u2019000")).toEqual(["1'000.50", '2\u2019000']);
  });

  it('records digits, groups and locale value for each numeral', () => {
    expect(extractNumerals('1,000.50', EN)).toEqual([
      {
        surface: '1,000.50',
        digits: '100050',
        groups: ['1', '0', '50'],
        value: '1000.50',
      },
    ]);
  });
});

describe('canonicalValue', () => {
  it.each<[string, NumberFormat, string | null]>([
    ['1,000', EN, '1000'],
    ['1,000,000', EN, '1000000'],
    ['1,000.50', EN, '1000.50'],
    ['1.000', EN, '1.000'],
    ['3.14159', EN, '3.14159'],
    ['12,5', EN, null],
    ['1 000', EN, null],
    ['3.2.1', EN, null],
    ['1,0000', EN, null],
    ['007', EN, '7'],
    ['0', EN, '0'],
    ['1\u202F000,50', FR, '1000.50'],
    ['1 000 000', FR, '1000000'],
    ['0,5', FR, '0.5'],
    ['1.000,50', FR, null],
    ['1.000', FR, null],
    ['1.000,50', DE, '1000.50'],
    ['1.000.000', DE, '1000000'],
    ['1 000,50', DE, '1000.50'],
    ['1234,5', DE, '1234.5'],
    ['3.2.1', DE, null],
    ['1.000', ES, '1000'],
    ['1,000', ES, '1.000'],
    ["1'000.50", numberFormatFor('de-CH'), '1000.50'],
    ['1,000.50', numberFormatFor('es-MX'), '1000.50'],
  ])('%s under %o \u2192 %s', (surface, format, expected) => {
    expect(canonicalValue(surface, format)).toBe(expected);
  });

  it('for an unknown language, groups only by whitespace and has no decimal', () => {
    const format = numberFormatFor('xx');
    expect(canonicalValue('1 000', format)).toBe('1000');
    expect(canonicalValue('1,5', format)).toBeNull();
    expect(canonicalValue('1.5', format)).toBeNull();
  });
});

describe('compareNumerals', () => {
  const compare = (source: string, target: string, srcFormat = EN, tgtFormat = FR) =>
    compareNumerals(
      extractNumerals(source, srcFormat),
      extractNumerals(target, tgtFormat),
    );

  it('matches a correctly localised number by value', () => {
    const result = compare(
      'It costs 1,000.50 dollars',
      'Cela co\u00FBte 1\u202F000,50 dollars',
    );
    expect(result.missing).toEqual([]);
    expect(result.altered).toEqual([]);
  });

  it('matches a verbatim copy by surface even where the target locale writes it differently', () => {
    const result = compare('Version 3.5', 'Version 3.5');
    expect(result.missing).toEqual([]);
    expect(result.altered).toEqual([]);
  });

  it('reports a number found only by digits as altered', () => {
    const result = compare('1,000 units', '1 000 units', EN, EN);
    expect(result.missing).toEqual([]);
    expect(result.altered.map((a) => [a.from.surface, a.to.surface])).toEqual([
      ['1,000', '1 000'],
    ]);
  });

  it('reports a number absent by every reading as missing', () => {
    const result = compare('Chapter 12 has 40 pages', 'Le chapitre 12 a des pages');
    expect(result.missing.map((n) => n.surface)).toEqual(['40']);
    expect(result.altered).toEqual([]);
  });

  it('consumes each target numeral once', () => {
    const result = compare('10 and 10', '10', EN, EN);
    expect(result.missing.map((n) => n.surface)).toEqual(['10']);
  });

  it('prefers a value match over a digits match when both are on offer', () => {
    // Target has both `1000` (value match) and `10.00` (digits match);
    // the value match wins and nothing is altered.
    const result = compare('1,000', '10.00 and 1000', EN, EN);
    expect(result.missing).toEqual([]);
    expect(result.altered).toEqual([]);
  });

  it('finds an English date inside a German one by its components', () => {
    const result = compare(
      'Signed on 03/12/2025.',
      'Unterzeichnet am 12.03.2025.',
      EN,
      DE,
    );
    expect(result.missing).toEqual([]);
    expect(result.altered).toEqual([]);
  });

  it('finds a German date inside an English one by its components', () => {
    const result = compare(
      'Unterzeichnet am 12.03.2025.',
      'Signed on 03/12/2025.',
      DE,
      EN,
    );
    expect(result.missing).toEqual([]);
  });

  it('still reports a component-less number as missing next to a date', () => {
    const result = compare('On 03/12/2025, 40 people.', 'Am 12.03.2025.', EN, DE);
    expect(result.missing.map((n) => n.surface)).toEqual(['40']);
  });

  it('ignores numbers the target adds', () => {
    const result = compare('one', 'un, 2, 3', EN, FR);
    expect(result.missing).toEqual([]);
    expect(result.altered).toEqual([]);
  });
});
