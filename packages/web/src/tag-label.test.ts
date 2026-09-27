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
});
