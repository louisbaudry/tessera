import type { FormatEntry } from '@cat-tool/core';
import { describe, expect, it } from 'vitest';

import { describeFormat } from './tag-label.js';

const placeholder = (open: string): FormatEntry => ({
  id: 1,
  kind: 'other',
  visible: true,
  placement: 'in-run',
  open,
  close: '',
});

describe('describeFormat', () => {
  it('names a placeholder by what it shows on the page', () => {
    expect(describeFormat(placeholder('<w:br/>'))).toBe('line break');
    expect(describeFormat(placeholder('<w:cr/>'))).toBe('line break');
    expect(
      describeFormat(
        placeholder(
          '<w:fldSimple w:instr=" PAGE  \\* MERGEFORMAT "><w:r/></w:fldSimple>',
        ),
      ),
    ).toBe('field PAGE');
    expect(describeFormat(placeholder('<w:pgNum/>'))).toBe('page number');
    expect(describeFormat(placeholder('<w:yearLong/>'))).toBe('date');
    expect(describeFormat(placeholder('<m:oMath><m:r/></m:oMath>'))).toBe('equation');
  });

  it('calls a tag its table cannot explain an unknown tag', () => {
    expect(describeFormat(undefined)).toBe('unknown tag');
  });

  it('names an XLIFF tag by its disp, equiv or type, else by its element', () => {
    expect(describeFormat(placeholder('<ph id="1" type="fmt" disp="br"/>'))).toBe('br');
    expect(describeFormat(placeholder('<ph id="1" equiv="[price]"/>'))).toBe('[price]');
    expect(describeFormat(placeholder('<xlf:ph id="1" type="image"/>'))).toBe('image');
    expect(describeFormat(placeholder('<ph id="1"/>'))).toBe('placeholder');
    expect(describeFormat(placeholder('<cp hex="0001"/>'))).toBe('control character');
    const pair = (open: string): FormatEntry => ({
      ...placeholder(open),
      placement: 'inline',
      close: '</pc>',
    });
    expect(describeFormat(pair('<pc id="1" type="link">'))).toBe('link');
    expect(describeFormat(pair('<pc id="2">'))).toBe('tag');
    expect(describeFormat(pair('<mrk id="m" type="term">'))).toBe('marker term');
    expect(describeFormat(placeholder('<sc id="3"/>'))).toBe('sc');
  });
});
