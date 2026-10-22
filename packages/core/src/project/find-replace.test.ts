import { describe, expect, it } from 'vitest';

import type { FormatEntry, Token } from '../model/token.js';
import {
  compileFind,
  FIND_MAX_PATTERN_CHARS,
  findProblem,
  matchRanges,
  replaceInTokens,
  REPLACE_MAX_CHARS,
  replaceText,
  type CompiledFind,
  type FindSpec,
} from './find-replace.js';

const literal = (pattern: string, caseSensitive = false): FindSpec => ({
  pattern,
  regex: false,
  caseSensitive,
});
const regex = (pattern: string, caseSensitive = false): FindSpec => ({
  pattern,
  regex: true,
  caseSensitive,
});
const compiled = (spec: FindSpec): CompiledFind => {
  const c = compileFind(spec);
  if ('error' in c) throw new Error(c.error);
  return c;
};

describe('compileFind', () => {
  it('takes a text search literally: nothing typed in it is syntax', () => {
    const find = compiled(literal('a.b (c)+'));
    expect(replaceText('a.b (c)+ and aXb ccc', find, 'Z').text).toBe('Z and aXb ccc');
  });

  it('ignores case unless asked not to', () => {
    expect(
      replaceText('Deckel deckel DECKEL', compiled(literal('deckel')), 'x').count,
    ).toBe(3);
    expect(
      replaceText('Deckel deckel DECKEL', compiled(literal('deckel', true)), 'x').count,
    ).toBe(1);
  });

  it('says why a regular expression does not compile', () => {
    const c = compileFind(regex('(unclosed'));
    expect('error' in c && c.error).toMatch(/not a valid regular expression/);
    // The reason, not the pattern or its flags echoed back.
    expect('error' in c && c.error).not.toContain('(unclosed');
    expect('error' in c && c.error).not.toMatch(/giu/);
  });

  it('refuses a pattern that matches the empty string, which would match everywhere', () => {
    for (const pattern of ['a*', '^', '(?:)', 'x?', '$']) {
      const c = compileFind(regex(pattern));
      expect('error' in c, pattern).toBe(true);
    }
    // A text search for those characters is an ordinary one.
    expect('error' in compileFind(literal('a*'))).toBe(false);
  });

  it('refuses an empty pattern and a long one in either mode, so a run built from it cannot skip the check', () => {
    for (const regexMode of [false, true]) {
      const spec = { regex: regexMode, caseSensitive: false };
      expect('error' in compileFind({ ...spec, pattern: '' })).toBe(true);
      expect(
        'error' in
          compileFind({ ...spec, pattern: 'a'.repeat(FIND_MAX_PATTERN_CHARS + 1) }),
      ).toBe(true);
    }
  });

  it('allows a zero-width pattern that does not match the empty string', () => {
    expect('error' in compileFind(regex('\\bfoo\\b'))).toBe(false);
    expect('error' in compileFind(regex('(?<=a)b'))).toBe(false);
  });
});

describe('findProblem', () => {
  it('is null for an ordinary search and says what is wrong otherwise', () => {
    expect(findProblem(literal('x'), 'y')).toBeNull();
    expect(findProblem(literal(''), 'y')).toBe('Type what to find.');
    expect(findProblem(literal('a'.repeat(FIND_MAX_PATTERN_CHARS + 1)), '')).toMatch(
      /at most/,
    );
    expect(findProblem(literal('a'), 'b'.repeat(REPLACE_MAX_CHARS + 1))).toMatch(
      /at most/,
    );
    expect(findProblem(regex('('), '')).toMatch(/valid regular expression/);
  });

  it('accepts an empty replacement, which deletes', () => {
    expect(findProblem(literal('x'), '')).toBeNull();
  });
});

describe('replaceText', () => {
  it('takes a text search replacement verbatim, a dollar included', () => {
    const find = compiled(literal('price'));
    expect(replaceText('the price', find, '$1 & $&').text).toBe('the $1 & $&');
  });

  it('gives a regular expression JavaScript’s $1, $& and $$', () => {
    const find = compiled(regex('(\\w+)@(\\w+)'));
    expect(replaceText('ann@home', find, '$2:$1 [$&] $$').text).toBe(
      'home:ann [ann@home] $',
    );
  });

  it('counts every match and changes nothing when there is none', () => {
    const find = compiled(literal('a'));
    expect(replaceText('banana', find, 'o')).toEqual({ text: 'bonono', count: 3 });
    expect(replaceText('xyz', find, 'o')).toEqual({ text: 'xyz', count: 0 });
  });

  it('works on a surrogate pair as one character', () => {
    expect(replaceText('a\u{1F600}b', compiled(regex('.')), 'x').count).toBe(3);
  });
});

describe('matchRanges', () => {
  it('gives where each match sits, in UTF-16 offsets', () => {
    const text = '\u{1F600} set up, set up';
    const ranges = matchRanges(text, compiled(literal('set up')));
    expect(ranges.map((r) => text.slice(r.start, r.end))).toEqual(['set up', 'set up']);
  });

  it('leaves out an empty match', () => {
    expect(matchRanges('abc', compiled(regex('(?=b)b?')))).toEqual([
      { start: 1, end: 2 },
    ]);
  });
});

describe('replaceInTokens', () => {
  const formats: FormatEntry[] = [
    { id: 1, visible: true } as unknown as FormatEntry,
    { id: 2, visible: false } as unknown as FormatEntry,
  ];
  const text = (v: string): Token => ({ t: 'text', v });

  it('rewrites text runs and leaves every visible tag where it was', () => {
    const tokens: Token[] = [
      text('Open the '),
      { t: 'open', id: 1, fmt: 1 },
      text('lid'),
      { t: 'close', id: 1 },
      text(' of the lid.'),
    ];
    const result = replaceInTokens(tokens, formats, compiled(literal('lid')), 'cover');
    expect(result.count).toBe(2);
    // Where the matches sat in the plain text before: tags take no room.
    expect(result.ranges).toEqual([
      { start: 9, end: 12 },
      { start: 20, end: 23 },
    ]);
    expect(result.tokens).toEqual([
      text('Open the '),
      { t: 'open', id: 1, fmt: 1 },
      text('cover'),
      { t: 'close', id: 1 },
      text(' of the cover.'),
    ]);
  });

  it('does not find a match that would cross a visible tag', () => {
    const tokens: Token[] = [
      text('set '),
      { t: 'open', id: 1, fmt: 1 },
      text('up'),
      { t: 'close', id: 1 },
    ];
    const result = replaceInTokens(tokens, formats, compiled(literal('set up')), 'x');
    expect(result.count).toBe(0);
    expect(result.tokens).toEqual(tokens);
  });

  it('finds a match a hidden tag sits inside, and removes that tag from view (it is carried back on write)', () => {
    const tokens: Token[] = [text('set '), { t: 'ph', id: 2, fmt: 2 }, text('up now')];
    const result = replaceInTokens(tokens, formats, compiled(literal('set up')), 'start');
    expect(result.count).toBe(1);
    expect(result.tokens).toEqual([text('start now')]);
  });

  it('finds a match across two text tokens that were only split for storage', () => {
    const result = replaceInTokens(
      [text('se'), text('t up')],
      formats,
      compiled(literal('set up')),
      'x',
    );
    expect(result).toEqual({
      tokens: [text('x')],
      count: 1,
      ranges: [{ start: 0, end: 6 }],
    });
  });

  it('drops a text run replaced with nothing, and keeps the tags around it', () => {
    const tokens: Token[] = [
      { t: 'open', id: 1, fmt: 1 },
      text('draft'),
      { t: 'close', id: 1 },
    ];
    const result = replaceInTokens(tokens, formats, compiled(literal('draft')), '');
    expect(result.tokens).toEqual([
      { t: 'open', id: 1, fmt: 1 },
      { t: 'close', id: 1 },
    ]);
  });
});
