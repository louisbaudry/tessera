import { describe, expect, it } from 'vitest';

import type { FormatEntry, Token } from '../model/token.js';
import { fuzzyOrigin, fuzzyScoreOfOrigin } from '../model/segment.js';
import { operandOfSource, operandOfTm, scoreFuzzy, type FuzzyOperand } from './fuzzy.js';

const op = (plain: string, tagSlots: string[] = []): FuzzyOperand => ({
  plain,
  tagSlots,
});

describe('scoreFuzzy', () => {
  it('scores the share of words kept, rounded down', () => {
    // 1 word of 4 replaced: 75 exactly.
    expect(scoreFuzzy(op('the red car stops'), op('the red car runs'))).toBe(75);
    // 1 of 3: 66.67 rounds down to 66, never up into a better band.
    expect(scoreFuzzy(op('the red car'), op('the red bus'))).toBe(66);
  });

  it('is never 100: that is the exact tier', () => {
    expect(scoreFuzzy(op('Hello there'), op('hello there'))).toBe(99);
    expect(scoreFuzzy(op('Hello, there!'), op('Hello there'))).toBe(99);
  });

  it('treats a changed number as a small penalty, not a replaced word', () => {
    const a = op('Pay 30 euros within 14 days of invoice');
    const b = op('Pay 45 euros within 14 days of invoice');
    // Same words by class: 100 less one numeral miss (2).
    expect(scoreFuzzy(a, b)).toBe(98);
    // A replaced word in the same place would have cost far more.
    expect(scoreFuzzy(op('Pay thirty euros within 14 days of invoice'), a)).toBeLessThan(
      90,
    );
  });

  it('reads 3.5 and 1,000 as one numeral each', () => {
    expect(scoreFuzzy(op('Version 3.5 is out'), op('Version 4.0 is out'))).toBe(98);
    expect(scoreFuzzy(op('Pay 1,000 now'), op('Pay 2,000 now'))).toBe(98);
  });

  it('charges 1 point per tag on one side only, at most 5', () => {
    // Base 80 (one word of five replaced), so the penalty is visible.
    const a = 'click the save button now';
    const b = 'click the save button today';
    expect(scoreFuzzy(op(a, ['open:b']), op(b, []))).toBe(79);
    expect(scoreFuzzy(op(a, ['open:b']), op(b, ['open:b']))).toBe(80);
    const many = Array.from({ length: 9 }, () => 'ph:other');
    expect(scoreFuzzy(op(a, many), op(b, []))).toBe(75);
  });

  it("compares a unit's tags with all the segment's when its hidden ones are in them", () => {
    const a = 'click the save button now';
    const b = 'click the save button today';
    const segment = { plain: a, tagSlots: [], allTagSlots: ['open:other', 'ph:other'] };
    const tagged = op(b, ['open:other', 'ph:other']);
    // Visible tags alone differ by two, all of them by none: no penalty.
    expect(scoreFuzzy(segment, tagged)).toBe(80);
    expect(scoreFuzzy({ plain: a, tagSlots: [] }, tagged)).toBe(78);
  });

  it('returns null under the minimum, and stops early rather than finishing', () => {
    expect(scoreFuzzy(op('a b c d'), op('w x y z'))).toBeNull();
    expect(scoreFuzzy(op('the red car stops'), op('the red car runs'), 76)).toBeNull();
    expect(scoreFuzzy(op('the red car stops'), op('the red car runs'), 75)).toBe(75);
  });

  it('applies the penalties before the minimum, not after', () => {
    // Base 75, a tag penalty drops it under 75.
    expect(
      scoreFuzzy(op('the red car stops', ['open:b']), op('the red car runs'), 75),
    ).toBeNull();
  });

  it('gives a text with no words no score', () => {
    expect(scoreFuzzy(op('...'), op('!!'))).toBeNull();
    expect(scoreFuzzy(op(''), op(''))).toBeNull();
  });

  it('is symmetric in its words', () => {
    const a = op('open the file menu and choose save');
    const b = op('open the file menu then choose save as');
    expect(scoreFuzzy(a, b)).toBe(scoreFuzzy(b, a));
  });

  it('is not tripped by diacritics or non-Latin scripts', () => {
    expect(scoreFuzzy(op('el árbol está aquí'), op('el árbol está allí'))).toBe(75);
    expect(scoreFuzzy(op('это очень важно'), op('это совсем важно'))).toBe(66);
  });
});

describe('operands', () => {
  const formats: FormatEntry[] = [
    { id: 1, kind: 'b', xml: '<w:b/>', visible: true },
    { id: 2, kind: 'other', xml: '<w:lang/>', visible: false },
  ] as unknown as FormatEntry[];

  it("reads a segment's visible tags only, with kinds from its format table", () => {
    const tokens: Token[] = [
      { t: 'open', id: 2, fmt: 2 },
      { t: 'open', id: 1, fmt: 1 },
      { t: 'text', v: 'Save  ' },
      { t: 'close', id: 1 },
      { t: 'text', v: 'now' },
      { t: 'close', id: 2 },
    ];
    expect(operandOfSource(tokens, formats)).toEqual({
      plain: 'Save now',
      tagSlots: ['open:b'],
      allTagSlots: ['open:other', 'open:b'],
    });
  });

  it('reads a memory unit by its hinted kinds', () => {
    expect(
      operandOfTm([
        { t: 'open', id: 1, k: 'b' },
        { t: 'text', v: 'Save' },
        { t: 'close', id: 1 },
        { t: 'ph', id: 2 },
      ]),
    ).toEqual({ plain: 'Save', tagSlots: ['open:b', 'ph:?'] });
  });
});

describe('fuzzy origins', () => {
  it('records the score, and reads it back', () => {
    expect(fuzzyOrigin(87)).toBe('tm_fuzzy_87');
    expect(fuzzyScoreOfOrigin('tm_fuzzy_87')).toBe(87);
    expect(fuzzyScoreOfOrigin('tm_exact')).toBeNull();
    expect(fuzzyScoreOfOrigin(null)).toBeNull();
  });
});
