import type { FormatEntry, Token } from '@cat-tool/core';
import { describe, expect, it } from 'vitest';

import { toPieces } from './pieces.js';

const fmt = (id: number, kind: FormatEntry['kind'], visible = true): FormatEntry => ({
  id,
  kind,
  visible,
  placement: kind === 'br' ? 'in-run' : 'run',
  open: '<x>',
  close: kind === 'br' ? '' : '</x>',
});

describe('toPieces', () => {
  it('renders paired tags as two chips and a placeholder as one', () => {
    const tokens: Token[] = [
      { t: 'text', v: 'A ' },
      { t: 'open', id: 1, fmt: 1 },
      { t: 'text', v: 'bold' },
      { t: 'close', id: 1 },
      { t: 'ph', id: 2, fmt: 2 },
      { t: 'text', v: ' end' },
    ];
    expect(toPieces(tokens, [fmt(1, 'b'), fmt(2, 'br')])).toEqual([
      { kind: 'text', text: 'A ' },
      { kind: 'tag', role: 'open', id: 1, tagKind: 'b', label: '\u20391' },
      { kind: 'text', text: 'bold' },
      { kind: 'tag', role: 'close', id: 1, tagKind: 'b', label: '1\u203A' },
      { kind: 'tag', role: 'ph', id: 2, tagKind: 'br', label: '\u27E82\u27E9' },
      { kind: 'text', text: ' end' },
    ]);
  });

  it('drops invisible tags, close included, and joins the text around them', () => {
    const tokens: Token[] = [
      { t: 'text', v: 'spel' },
      { t: 'open', id: 1, fmt: 1 },
      { t: 'text', v: 'ling' },
      { t: 'close', id: 1 },
      { t: 'ph', id: 2, fmt: 2 },
      { t: 'text', v: '!' },
    ];
    expect(toPieces(tokens, [fmt(1, 'other', false), fmt(2, 'bookmark', false)])).toEqual(
      [{ kind: 'text', text: 'spelling!' }],
    );
  });

  it('shows a tag whose format it cannot find rather than hiding it', () => {
    const tokens: Token[] = [
      { t: 'close', id: 7 },
      { t: 'ph', id: 3, fmt: 9 },
    ];
    expect(toPieces(tokens, [])).toEqual([
      { kind: 'tag', role: 'close', id: 7, tagKind: null, label: '7\u203A' },
      { kind: 'tag', role: 'ph', id: 3, tagKind: null, label: '\u27E83\u27E9' },
    ]);
  });

  it('is empty for no tokens', () => {
    expect(toPieces([], [])).toEqual([]);
    expect(toPieces([{ t: 'text', v: '' }], [])).toEqual([]);
  });
});
