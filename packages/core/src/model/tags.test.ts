import { describe, expect, it } from 'vitest';

import {
  extraTags,
  missingTags,
  signaturesEqual,
  tagSignature,
  tagsMatch,
  validateTagStructure,
} from './tags.js';
import { plainText, type TmToken } from './token.js';

const text = (v: string): TmToken => ({ t: 'text', v });
const open = (id: number): TmToken => ({ t: 'open', id });
const close = (id: number): TmToken => ({ t: 'close', id });
const ph = (id: number): TmToken => ({ t: 'ph', id });

describe('validateTagStructure', () => {
  it('accepts plain text with no tags', () => {
    expect(validateTagStructure([text('Hello world')])).toEqual({ ok: true });
  });

  it('accepts a balanced pair', () => {
    // Click <1>here</1> to continue.
    const tokens = [
      text('Click '),
      open(1),
      text('here'),
      close(1),
      text(' to continue.'),
    ];
    expect(validateTagStructure(tokens)).toEqual({ ok: true });
  });

  it('accepts properly nested pairs', () => {
    // <1>bold <2>and italic</2></1>
    const tokens = [
      open(1),
      text('bold '),
      open(2),
      text('and italic'),
      close(2),
      close(1),
    ];
    expect(validateTagStructure(tokens)).toEqual({ ok: true });
  });

  it('accepts sequential, non-overlapping pairs', () => {
    const tokens = [
      open(1),
      text('a'),
      close(1),
      text(' '),
      open(2),
      text('b'),
      close(2),
    ];
    expect(validateTagStructure(tokens)).toEqual({ ok: true });
  });

  it('rejects interleaved pairs', () => {
    // <1><2></1></2> — well-formed as a sequence, invalid as a tree.
    const result = validateTagStructure([open(1), open(2), close(1), close(2)]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.errors).toContainEqual({
      code: 'interleaved',
      id: 1,
      expected: 2,
      index: 2,
    });
  });

  it('rejects a close with no matching open', () => {
    const result = validateTagStructure([text('a'), close(3)]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.errors).toEqual([{ code: 'close-without-open', id: 3, index: 1 }]);
  });

  it('rejects an unclosed open', () => {
    const result = validateTagStructure([open(1), text('dangling')]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.errors).toEqual([{ code: 'unclosed', id: 1, index: 0 }]);
  });

  it('rejects a duplicated tag id', () => {
    const result = validateTagStructure([open(1), close(1), open(1), close(1)]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.errors).toContainEqual({ code: 'duplicate-open', id: 1, index: 2 });
  });

  it('rejects a duplicated placeholder id', () => {
    const result = validateTagStructure([ph(1), text(' x '), ph(1)]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.errors).toContainEqual({ code: 'duplicate-ph', id: 1, index: 2 });
  });

  it('reports every problem, not just the first', () => {
    const result = validateTagStructure([close(9), open(1), close(2)]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('tagSignature', () => {
  it('is order-independent', () => {
    const a = [open(1), text('x'), close(1), open(2), text('y'), close(2)];
    const b = [open(2), text('y'), close(2), open(1), text('x'), close(1)];
    expect(signaturesEqual(tagSignature(a), tagSignature(b))).toBe(true);
  });

  it('separates pairs from placeholders', () => {
    expect(tagSignature([open(1), close(1), ph(2)])).toEqual({
      pairs: [1],
      placeholders: [2],
    });
  });
});

describe('tagsMatch', () => {
  it('allows the target to reorder tags', () => {
    // EN: <1>Save</1> the <2>file</2>
    // ES: <2>el archivo</2> <1>Guardar</1>  — reordered, still valid.
    const source = [
      open(1),
      text('Save'),
      close(1),
      text(' the '),
      open(2),
      text('file'),
      close(2),
    ];
    const target = [
      open(2),
      text('el archivo'),
      close(2),
      text(' '),
      open(1),
      text('Guardar'),
      close(1),
    ];
    expect(tagsMatch(source, target)).toBe(true);
  });

  it('rejects a target that drops a tag', () => {
    const source = [open(1), text('Save'), close(1), ph(2)];
    const target = [open(1), text('Guardar'), close(1)];
    expect(tagsMatch(source, target)).toBe(false);
  });

  it('rejects a target that invents a tag', () => {
    const source = [text('Save')];
    const target = [open(1), text('Guardar'), close(1)];
    expect(tagsMatch(source, target)).toBe(false);
  });
});

describe('missingTags / extraTags', () => {
  it('identifies what the target dropped', () => {
    const source = [open(1), text('a'), close(1), ph(2), ph(3)];
    const target = [open(1), text('a'), close(1), ph(3)];
    expect(missingTags(source, target)).toEqual({ pairs: [], placeholders: [2] });
    expect(extraTags(source, target)).toEqual({ pairs: [], placeholders: [] });
  });

  it('identifies what the target invented', () => {
    const source = [text('a')];
    const target = [open(4), text('a'), close(4)];
    expect(missingTags(source, target)).toEqual({ pairs: [], placeholders: [] });
    expect(extraTags(source, target)).toEqual({ pairs: [4], placeholders: [] });
  });
});

describe('plainText', () => {
  it('discards tags and keeps text in order', () => {
    const tokens = [open(1), text('¿Guardar'), ph(2), text(' el archivo?'), close(1)];
    expect(plainText(tokens)).toBe('¿Guardar el archivo?');
  });
});
