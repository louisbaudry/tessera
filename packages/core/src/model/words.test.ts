import { describe, expect, it } from 'vitest';

import type { FormatEntry, Token, TokenizedRegion } from './token.js';
import { countRegionWords, countWords, isWordSeparator, segmentWords } from './words.js';

describe('countWords', () => {
  it.each([
    ['hello world', 2],
    ['hello   world\n\nfoo', 3],
    ['', 0],
    ['   \n\t ', 0],
    // One word each: joined by a mark, not a space.
    ['e-mail', 1],
    ["l'homme", 1],
    ['1,000.50', 1],
    ['état-major', 1],
    // A tab, a no-break space and a zero-width space all separate words.
    ['one\ttwo', 2],
    ['10 000', 2],
    ['one​two', 2],
    // Something readable is required: bare punctuation is not a word.
    ['a — b', 2],
    ['• item', 1],
    ['« bonjour »', 1],
    ['- - -', 0],
    // A byte-order mark neither counts nor joins.
    ['﻿one two', 2],
    ['one ﻿ two', 2],
  ])('%j is %i', (text, n) => {
    expect(countWords(text)).toBe(n);
  });
});

describe('isWordSeparator', () => {
  it('is whitespace plus the zero-width space, for every UTF-16 code unit', () => {
    const reference = /^[\s\u200B]$/u;
    const differing: number[] = [];
    for (let code = 0; code <= 0xffff; code++) {
      if (isWordSeparator(code) !== reference.test(String.fromCharCode(code))) {
        differing.push(code);
      }
    }
    expect(differing).toEqual([]);
  });
});

describe('countWords beyond the BMP', () => {
  it('reads an astral letter or number, and skips an astral symbol', () => {
    expect(countWords('\u{1D400}\u{1D401} \u{1F600}')).toBe(1); // bold A B; an emoji
    expect(countWords('\u{20BB7}')).toBe(1); // a CJK ideograph outside the BMP
    expect(countWords('\u{1F600} \u{1F600}')).toBe(0);
    expect(countWords('x\u{1F600}y z')).toBe(2);
  });
});

const ph = (id: number, open: string): [Token, FormatEntry] => [
  { t: 'ph', id, fmt: id },
  { id, kind: 'other', visible: false, placement: 'in-run', open, close: '' },
];

/** A region of `text` and `ph` pieces, in order. */
function region(...pieces: Array<string | [Token, FormatEntry]>): TokenizedRegion {
  const tokens: Token[] = [];
  const formats: FormatEntry[] = [];
  for (const piece of pieces) {
    if (typeof piece === 'string') tokens.push({ t: 'text', v: piece });
    else {
      tokens.push(piece[0]);
      formats.push(piece[1]);
    }
  }
  return { tokens, formats };
}

describe('countRegionWords', () => {
  it.each([
    ['w:tab', '<w:tab/>', 2],
    ['w:ptab', '<w:ptab w:relativeTo="margin"/>', 2],
    ['w:br', '<w:br/>', 2],
    ['w:cr', '<w:cr/>', 2],
    ['w:softHyphen', '<w:softHyphen/>', 1],
    ['w:sym', '<w:sym w:font="Wingdings" w:char="F0FC"/>', 1],
    ['w:bookmarkStart', '<w:bookmarkStart w:id="0" w:name="a"/>', 1],
    ['w:proofErr', '<w:proofErr w:type="spellStart"/>', 1],
    ['w:footnoteReference', '<w:footnoteReference w:id="2"/>', 1],
  ])('%s between two halves of "ab" splits or joins as written', (_name, xml, n) => {
    expect(countRegionWords(region('foo', ph(1, xml), 'bar'))).toBe(n);
  });

  it('reads w:noBreakHyphen as a hyphen, so e<hyphen>mail is one word', () => {
    expect(countRegionWords(region('e', ph(1, '<w:noBreakHyphen/>'), 'mail'))).toBe(1);
  });

  it('counts a word split by tags around it once', () => {
    const tokens: Token[] = [
      { t: 'text', v: 'to' },
      { t: 'open', id: 1, fmt: 1 },
      { t: 'text', v: 'day' },
      { t: 'close', id: 1 },
    ];
    const formats: FormatEntry[] = [
      {
        id: 1,
        kind: 'b',
        visible: true,
        placement: 'run',
        open: '<w:r>',
        close: '</w:r>',
      },
    ];
    expect(countRegionWords({ tokens, formats })).toBe(1);
  });

  it('reads a placeholder with an unknown format as joining', () => {
    expect(
      countRegionWords({
        tokens: [
          { t: 'text', v: 'a' },
          { t: 'ph', id: 9, fmt: 9 },
          { t: 'text', v: 'b' },
        ],
        formats: [],
      }),
    ).toBe(1);
  });
});

describe('segmentWords (backlog #34)', () => {
  const seg = {
    sourceTokens: [{ t: 'text', v: 'three short words' }],
    formatTable: [],
  } as const;

  it('counts a translatable segment, and nothing for a locked one or a fallback copy', () => {
    expect(segmentWords({ ...seg, locked: false, fallbackCopy: false })).toBe(3);
    expect(segmentWords({ ...seg, locked: true, fallbackCopy: false })).toBe(0);
    expect(segmentWords({ ...seg, locked: false, fallbackCopy: true })).toBe(0);
  });
});
