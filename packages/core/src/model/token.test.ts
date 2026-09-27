import { describe, expect, it } from 'vitest';

import {
  parseTokens,
  TokenShapeError,
  xmlIllegalChar,
  type FormatEntry,
} from './token.js';

const BOLD: FormatEntry = {
  id: 1,
  kind: 'b',
  visible: true,
  placement: 'run',
  open: '<w:r><w:rPr><w:b/></w:rPr>',
  close: '</w:r>',
};

const BR: FormatEntry = {
  id: 3,
  kind: 'br',
  visible: true,
  placement: 'in-run',
  open: '<w:br/>',
  close: '',
};

describe('parseTokens', () => {
  it('returns a well-formed target as tokens, dropping unknown fields', () => {
    const raw = [
      { t: 'text', v: 'Hallo ' },
      { t: 'open', id: 1, fmt: 1, extra: 'ignored' },
      { t: 'text', v: 'Welt' },
      { t: 'close', id: 1 },
    ];
    expect(parseTokens(raw, [BOLD])).toEqual([
      { t: 'text', v: 'Hallo ' },
      { t: 'open', id: 1, fmt: 1 },
      { t: 'text', v: 'Welt' },
      { t: 'close', id: 1 },
    ]);
  });

  it.each([
    ['not an array', { t: 'text', v: 'x' }],
    // The renderer looks a tag up by its id, a hidden-tag check by its fmt.
    ['a fmt other than its own id', [{ t: 'open', id: 1, fmt: 2 }]],
    // A pair's format as a placeholder: XML with no close.
    ['a pair tag as a placeholder', [{ t: 'ph', id: 1, fmt: 1 }]],
    ['a placeholder tag as a pair', [{ t: 'open', id: 3, fmt: 3 }]],
    ['a close of a placeholder tag', [{ t: 'close', id: 3 }]],
    ['a close of a tag the table lacks', [{ t: 'close', id: 9 }]],
    ['a non-object', ['x']],
    ['an unknown kind', [{ t: 'bold', v: 'x' }]],
    ['text without a string', [{ t: 'text', v: 3 }]],
    ['a negative id', [{ t: 'close', id: -1 }]],
    ['a fmt outside the format table', [{ t: 'ph', id: 1, fmt: 9 }]],
    // A vertical tab is PowerPoint's soft line break, and pastes.
    ['a control character XML cannot carry', [{ t: 'text', v: 'a\u000Bb' }]],
    ['half a surrogate pair', [{ t: 'text', v: 'a\uD83Db' }]],
    ['a noncharacter', [{ t: 'text', v: '\uFFFE' }]],
  ])('refuses %s', (_label, raw) => {
    expect(() => parseTokens(raw, [BOLD, BR])).toThrow(TokenShapeError);
  });

  it('keeps what XML can carry: tabs, line breaks, astral characters', () => {
    const v = 'a\tb\nc\r\u{1F600}';
    expect(parseTokens([{ t: 'text', v }], [])).toEqual([{ t: 'text', v }]);
  });
});

describe('xmlIllegalChar', () => {
  it('names the first character XML cannot carry', () => {
    expect(xmlIllegalChar('ok\u000Cand\u0001')).toBe('U+000C');
    expect(xmlIllegalChar('\uDC00')).toBe('U+DC00');
    expect(xmlIllegalChar('plain \u{1F600} text')).toBeNull();
  });
});
