import { describe, expect, it } from 'vitest';

import type { FormatEntry, TmToken, Token } from '../model/token.js';
import { placeMatch } from './pretranslate.js';

describe('placeMatch', () => {
  it('remaps tags onto the receiving segment when the multiset matches — tagsMatched: true', () => {
    const matchTokens: TmToken[] = [
      { t: 'open', id: 1, k: 'b' },
      { t: 'text', v: 'Hola' },
      { t: 'close', id: 1 },
    ];
    const sourceTokens: Token[] = [
      { t: 'open', id: 10, fmt: 10 },
      { t: 'text', v: 'x' },
      { t: 'close', id: 10 },
    ];
    const formats: FormatEntry[] = [
      { id: 10, kind: 'b', visible: true, placement: 'run', open: '', close: '' },
    ];
    const result = placeMatch(matchTokens, sourceTokens, formats);
    expect(result.tagsMatched).toBe(true);
    expect(result.targetTokens).toEqual([
      { t: 'open', id: 10, fmt: 10 },
      { t: 'text', v: 'Hola' },
      { t: 'close', id: 10 },
    ]);
  });

  it('a plain-text match onto a plain-text source needs no remapping at all', () => {
    const result = placeMatch(
      [{ t: 'text', v: 'Hola mundo' }],
      [{ t: 'text', v: 'Hello world' }],
      [],
    );
    expect(result).toEqual({
      tagsMatched: true,
      targetTokens: [{ t: 'text', v: 'Hola mundo' }],
    });
  });

  it('falls back to plain text with every tag dropped when the tag multiset differs — never a guessed placement', () => {
    const matchTokens: TmToken[] = [
      { t: 'open', id: 1, k: 'b' },
      { t: 'text', v: 'Hola ' },
      { t: 'close', id: 1 },
      { t: 'open', id: 2, k: 'i' },
      { t: 'text', v: 'mundo' },
      { t: 'close', id: 2 },
    ];
    // The receiving segment's source has no tags at all — same plain
    // text can genuinely have arrived with different formatting.
    const sourceTokens: Token[] = [{ t: 'text', v: 'Hello world' }];
    const result = placeMatch(matchTokens, sourceTokens, []);
    expect(result.tagsMatched).toBe(false);
    expect(result.targetTokens).toEqual([{ t: 'text', v: 'Hola mundo' }]);
  });

  it('falls back to plain text when a kind occurs a different number of times', () => {
    const matchTokens: TmToken[] = [
      { t: 'open', id: 1, k: 'b' },
      { t: 'text', v: 'a' },
      { t: 'close', id: 1 },
      { t: 'open', id: 2, k: 'b' },
      { t: 'text', v: 'b' },
      { t: 'close', id: 2 },
    ];
    const sourceTokens: Token[] = [
      { t: 'open', id: 1, fmt: 1 },
      { t: 'text', v: 'only one' },
      { t: 'close', id: 1 },
    ];
    const formats: FormatEntry[] = [
      { id: 1, kind: 'b', visible: true, placement: 'run', open: '', close: '' },
    ];
    const result = placeMatch(matchTokens, sourceTokens, formats);
    expect(result.tagsMatched).toBe(false);
    expect(result.targetTokens).toEqual([{ t: 'text', v: 'ab' }]);
  });

  it('never produces a target with more or fewer tag kinds than the source when tags matched', () => {
    const matchTokens: TmToken[] = [
      { t: 'text', v: 'a' },
      { t: 'ph', id: 1, k: 'br' },
      { t: 'text', v: 'b' },
    ];
    const sourceTokens: Token[] = [
      { t: 'text', v: 'x' },
      { t: 'ph', id: 5, fmt: 5 },
      { t: 'text', v: 'y' },
    ];
    const formats: FormatEntry[] = [
      {
        id: 5,
        kind: 'br',
        visible: true,
        placement: 'in-run',
        open: '<w:br/>',
        close: '',
      },
    ];
    const result = placeMatch(matchTokens, sourceTokens, formats);
    expect(result.tagsMatched).toBe(true);
    expect(result.targetTokens).toEqual([
      { t: 'text', v: 'a' },
      { t: 'ph', id: 5, fmt: 5 },
      { t: 'text', v: 'b' },
    ]);
  });
});
