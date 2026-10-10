import { describe, expect, it } from 'vitest';

import {
  cleanDraft,
  cleanSelection,
  draftFromSelection,
  draftProblem,
  EMPTY_DRAFT,
  isAddTermKey,
  MAX_TERM_CHARS,
} from './add-term.js';

describe('draftFromSelection', () => {
  it('puts a source selection in the source side and leaves the rendering to be typed', () => {
    expect(draftFromSelection('source', ' parish\n council ')).toEqual({
      draft: { source: 'parish council', target: '' },
      note: null,
    });
  });

  it('puts a target selection in the rendering side', () => {
    expect(draftFromSelection('target', 'Gemeinde').draft).toEqual({
      source: '',
      target: 'Gemeinde',
    });
  });

  it('opens an empty box for no selection, with nothing to explain', () => {
    expect(draftFromSelection(null, 'ignored')).toEqual({
      draft: EMPTY_DRAFT,
      note: null,
    });
    expect(draftFromSelection('source', '  \n ')).toEqual({
      draft: EMPTY_DRAFT,
      note: null,
    });
  });

  it('leaves out a selection too long to be a term, and says so', () => {
    const long = draftFromSelection('source', 'word '.repeat(MAX_TERM_CHARS));
    expect(long.draft).toEqual(EMPTY_DRAFT);
    expect(long.note).toMatch(/longer than a term/);
  });
});

describe('draftProblem', () => {
  it('asks for each side in turn, and is satisfied by two cleaned sides', () => {
    expect(draftProblem(EMPTY_DRAFT)).toMatch(/source/);
    expect(draftProblem({ source: 'parish', target: '  ' })).toMatch(/rendering/);
    expect(draftProblem({ source: ' parish ', target: 'Gemeinde' })).toBeNull();
  });

  it('refuses a side over the limit', () => {
    expect(draftProblem({ source: 'a', target: 'b'.repeat(MAX_TERM_CHARS + 1) })).toMatch(
      /at most/,
    );
  });
});

describe('cleaning', () => {
  it('collapses whitespace the same way for a selection and a typed draft', () => {
    expect(cleanSelection('  a \t b\n c ')).toBe('a b c');
    expect(cleanDraft({ source: ' a  b ', target: 'c\nd' })).toEqual({
      source: 'a b',
      target: 'c d',
    });
  });
});

describe('isAddTermKey', () => {
  const key = (over: Partial<Parameters<typeof isAddTermKey>[0]> = {}) => ({
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: true,
    code: 'KeyD',
    ...over,
  });
  it('is Ctrl+Shift+D and nothing else', () => {
    expect(isAddTermKey(key())).toBe(true);
    expect(isAddTermKey(key({ shiftKey: false }))).toBe(false);
    expect(isAddTermKey(key({ ctrlKey: false }))).toBe(false);
    expect(isAddTermKey(key({ altKey: true }))).toBe(false);
    expect(isAddTermKey(key({ metaKey: true }))).toBe(false);
    expect(isAddTermKey(key({ code: 'KeyF' }))).toBe(false);
  });
});
