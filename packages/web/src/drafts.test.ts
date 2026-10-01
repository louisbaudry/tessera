import type { Segment, Token } from '@cat-tool/core';
import { describe, expect, it } from 'vitest';

import {
  createDrafts,
  draftText,
  DRAFT_MAX_AGE_MS,
  recoverDrafts,
  type Draft,
  type DraftStorage,
} from './drafts.js';

const text = (v: string): Token[] => [{ t: 'text', v }];

/** `localStorage` as a map, in insertion order. */
function memoryStorage(): DraftStorage & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

const draft = (v: string, base = 'v1', savedAt = 1000): Draft => ({
  base,
  sourceHash: 'h1',
  tokens: text(v),
  savedAt,
});

function segment(id: number, target: string | null, updatedAt = 'v1'): Segment {
  return {
    id,
    fileId: 1,
    part: 'document',
    ord: id,
    paraKey: 'p1',
    paraOrd: id,
    sourceTokens: text('Source'),
    formatTable: [],
    targetTokens: target === null ? null : text(target),
    sourceHash: 'h1',
    status: target === null ? 'new' : 'translated',
    origin: null,
    locked: false,
    fallbackCopy: false,
    updatedAt,
  };
}

describe('createDrafts', () => {
  it('keeps one draft per segment, read back as written', () => {
    const drafts = createDrafts(memoryStorage(), { account: 1, project: 'p' });
    drafts.write(7, draft('Hallo'));
    drafts.write(7, draft('Hallo Welt'));
    expect(drafts.read(7)).toEqual(draft('Hallo Welt'));
    drafts.clear(7);
    expect(drafts.read(7)).toBeUndefined();
  });

  it('never shows one account or project the drafts of another', () => {
    const storage = memoryStorage();
    createDrafts(storage, { account: 1, project: 'p' }).write(7, draft('mine'));
    createDrafts(storage, { account: 1, project: 'p.1' }).write(8, draft('dotted'));
    expect([...createDrafts(storage, { account: 2, project: 'p' }).all().keys()]).toEqual(
      [],
    );
    expect([
      ...createDrafts(storage, { account: 1, project: 'p' }).all(1000).keys(),
    ]).toEqual([7]);
  });

  it('removes what has expired or cannot be read, and leaves other keys alone', () => {
    const storage = memoryStorage();
    const drafts = createDrafts(storage, { account: 1, project: 'p' });
    drafts.write(1, draft('old', 'v1', 0));
    drafts.write(2, draft('new', 'v1', DRAFT_MAX_AGE_MS));
    storage.setItem('cat-tool.draft.1.p.3', '{not json');
    storage.setItem('cat-tool.session', 'token');
    expect([...drafts.all(DRAFT_MAX_AGE_MS + 1).keys()]).toEqual([2]);
    expect([...storage.map.keys()].sort()).toEqual([
      'cat-tool.draft.1.p.2',
      'cat-tool.session',
    ]);
  });

  it('is the editor without autosave when storage is absent or throws', () => {
    const throwing: DraftStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
      key: () => {
        throw new Error('blocked');
      },
      get length(): number {
        throw new Error('blocked');
      },
    };
    for (const storage of [null, throwing]) {
      const drafts = createDrafts(storage, { account: 1, project: 'p' });
      expect(() => drafts.write(1, draft('x'))).not.toThrow();
      expect(drafts.read(1)).toBeUndefined();
      expect(() => drafts.clear(1)).not.toThrow();
      expect(drafts.all().size).toBe(0);
    }
  });
});

describe('recoverDrafts', () => {
  it('resends a draft over the version still stored', () => {
    const r = recoverDrafts([segment(1, 'Alt')], new Map([[1, draft('Neu')]]));
    expect(r).toEqual({
      resend: [{ id: 1, tokens: text('Neu') }],
      conflicts: [],
      drop: [],
    });
  });

  it('drops a draft whose write landed, even over an older version', () => {
    const r = recoverDrafts([segment(1, 'Neu', 'v2')], new Map([[1, draft('Neu')]]));
    expect(r).toEqual({ resend: [], conflicts: [], drop: [1] });
  });

  it('drops a blank draft on an untranslated segment', () => {
    const r = recoverDrafts([segment(1, null)], new Map([[1, draft('  ')]]));
    expect(r.drop).toEqual([1]);
  });

  it('resends a blank draft over a stored target: clearing it is an edit', () => {
    const r = recoverDrafts([segment(1, 'Alt')], new Map([[1, draft('')]]));
    expect(r.resend).toEqual([{ id: 1, tokens: text('') }]);
  });

  it('never replaces a segment saved elsewhere since: a conflict', () => {
    const r = recoverDrafts([segment(1, 'Andere', 'v2')], new Map([[1, draft('Neu')]]));
    expect(r).toEqual({
      resend: [],
      conflicts: [{ id: 1, tokens: text('Neu') }],
      drop: [],
    });
  });

  it('drops a draft typed against another source', () => {
    const r = recoverDrafts(
      [segment(1, null)],
      new Map([[1, { ...draft('Neu'), sourceHash: 'h0' }]]),
    );
    expect(r.drop).toEqual([1]);
  });

  it('leaves the drafts of other files alone', () => {
    const r = recoverDrafts([segment(1, null)], new Map([[9, draft('Neu')]]));
    expect(r).toEqual({ resend: [], conflicts: [], drop: [] });
  });
});

describe('draftText', () => {
  it('is the words, chips left out', () => {
    expect(
      draftText([
        { t: 'text', v: 'Hallo ' },
        { t: 'ph', id: 1, fmt: 0 } as Token,
        { t: 'text', v: '  Welt\n' },
      ]),
    ).toBe('Hallo Welt');
  });
});
