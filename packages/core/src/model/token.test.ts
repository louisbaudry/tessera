import { describe, expect, it } from 'vitest';

import { parseTokens, TokenShapeError, type FormatEntry } from './token.js';

const BOLD: FormatEntry = {
  id: 1,
  kind: 'b',
  visible: true,
  placement: 'run',
  open: '<w:r><w:rPr><w:b/></w:rPr>',
  close: '</w:r>',
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
    ['a non-object', ['x']],
    ['an unknown kind', [{ t: 'bold', v: 'x' }]],
    ['text without a string', [{ t: 'text', v: 3 }]],
    ['a negative id', [{ t: 'close', id: -1 }]],
    ['a fmt outside the format table', [{ t: 'ph', id: 1, fmt: 9 }]],
  ])('refuses %s', (_label, raw) => {
    expect(() => parseTokens(raw, [BOLD])).toThrow(TokenShapeError);
  });
});
