import { describe, expect, it } from 'vitest';

import type { Segment } from '../model/segment.js';
import type { Token } from '../model/token.js';
import { hashOf } from './normalize.js';
import {
  confirmedTargetContext,
  documentContext,
  sourceDocumentContext,
  type ContextEntry,
} from './context.js';

function entry(id: number, ord: number, hash: string, locked = false): ContextEntry {
  return { id, ord, hash, locked };
}

describe('documentContext', () => {
  it('gives the middle of a three-segment chain both neighbours', () => {
    const result = documentContext([
      entry(1, 0, 'hash-a'),
      entry(2, 1, 'hash-b'),
      entry(3, 2, 'hash-c'),
    ]);
    expect(result.get(1)).toEqual({ prevHash: null, nextHash: 'hash-b' });
    expect(result.get(2)).toEqual({ prevHash: 'hash-a', nextHash: 'hash-c' });
    expect(result.get(3)).toEqual({ prevHash: 'hash-b', nextHash: null });
  });

  it('gives a single segment null on both sides', () => {
    const result = documentContext([entry(1, 0, 'hash-a')]);
    expect(result.get(1)).toEqual({ prevHash: null, nextHash: null });
  });

  it('sorts by ord internally, regardless of input order', () => {
    const result = documentContext([
      entry(3, 2, 'hash-c'),
      entry(1, 0, 'hash-a'),
      entry(2, 1, 'hash-b'),
    ]);
    expect(result.get(2)).toEqual({ prevHash: 'hash-a', nextHash: 'hash-c' });
  });

  it('skips a locked segment as a neighbour, on both sides of it', () => {
    // A (translatable) — B (locked, e.g. a page-break marker) — C (translatable)
    const result = documentContext([
      entry(1, 0, 'hash-a'),
      entry(2, 1, 'hash-locked', true),
      entry(3, 2, 'hash-c'),
    ]);
    expect(result.get(1)).toEqual({ prevHash: null, nextHash: 'hash-c' });
    expect(result.get(3)).toEqual({ prevHash: 'hash-a', nextHash: null });
  });

  it('never keys a locked segment in the result — it is never confirmed, never a tuv', () => {
    const result = documentContext([
      entry(1, 0, 'hash-a'),
      entry(2, 1, 'hash-locked', true),
    ]);
    expect(result.has(2)).toBe(false);
  });

  it('returns an empty map when every segment is locked', () => {
    const result = documentContext([
      entry(1, 0, 'hash-a', true),
      entry(2, 1, 'hash-b', true),
    ]);
    expect(result.size).toBe(0);
  });

  it('two locked segments in a row are both skipped as neighbours', () => {
    const result = documentContext([
      entry(1, 0, 'hash-a'),
      entry(2, 1, 'hash-locked-1', true),
      entry(3, 2, 'hash-locked-2', true),
      entry(4, 3, 'hash-d'),
    ]);
    expect(result.get(1)).toEqual({ prevHash: null, nextHash: 'hash-d' });
    expect(result.get(4)).toEqual({ prevHash: 'hash-a', nextHash: null });
  });
});

function segment(overrides: Partial<Segment>): Segment {
  return {
    id: 1,
    fileId: 1,
    part: 'document',
    ord: 0,
    paraKey: 's1',
    paraOrd: 0,
    sourceTokens: [],
    formatTable: [],
    targetTokens: null,
    sourceHash: 'hash-default',
    status: 'new',
    origin: null,
    locked: false,
    updatedAt: '2026-09-08T00:00:00.000Z',
    ...overrides,
  };
}

describe('sourceDocumentContext', () => {
  it('uses sourceHash as the context chain hash', () => {
    const segments = [
      segment({ id: 1, ord: 0, sourceHash: 'hash-a' }),
      segment({ id: 2, ord: 1, sourceHash: 'hash-b' }),
      segment({ id: 3, ord: 2, sourceHash: 'hash-c' }),
    ];
    const result = sourceDocumentContext(segments);
    expect(result.get(2)).toEqual({ prevHash: 'hash-a', nextHash: 'hash-c' });
  });

  it('agrees with documentContext given the equivalent ContextEntry array', () => {
    const segments = [
      segment({ id: 1, ord: 0, sourceHash: 'hash-a' }),
      segment({ id: 2, ord: 1, sourceHash: 'hash-locked', locked: true }),
      segment({ id: 3, ord: 2, sourceHash: 'hash-c' }),
    ];
    const viaWrapper = sourceDocumentContext(segments);
    const viaDirect = documentContext(
      segments.map((s) => ({
        id: s.id,
        ord: s.ord,
        hash: s.sourceHash,
        locked: s.locked,
      })),
    );
    expect(viaWrapper).toEqual(viaDirect);
  });
});

function text(v: string): readonly Token[] {
  return [{ t: 'text', v }];
}

describe('confirmedTargetContext', () => {
  it("chains over already-confirmed siblings' target hashes, not source hashes", () => {
    const segments = [
      segment({ id: 1, ord: 0, status: 'confirmed', targetTokens: text('Hola') }),
      segment({ id: 2, ord: 1, status: 'confirmed', targetTokens: text('mundo') }),
      segment({ id: 3, ord: 2, status: 'confirmed', targetTokens: text('hoy') }),
    ];
    const result = confirmedTargetContext(segments, 2);
    expect(result.get(2)).toEqual({ prevHash: hashOf('Hola'), nextHash: hashOf('hoy') });
  });

  it('includes the segment being confirmed even though its own status is not yet confirmed', () => {
    const segments = [
      segment({ id: 1, ord: 0, status: 'confirmed', targetTokens: text('Hola') }),
      segment({ id: 2, ord: 1, status: 'translated', targetTokens: text('mundo') }), // about to be confirmed
    ];
    const result = confirmedTargetContext(segments, 2);
    expect(result.get(2)).toEqual({ prevHash: hashOf('Hola'), nextHash: null });
  });

  it('treats an unconfirmed neighbour as absent from the chain — its target is not final yet', () => {
    const segments = [
      segment({ id: 1, ord: 0, status: 'confirmed', targetTokens: text('Hola') }),
      segment({
        id: 2,
        ord: 1,
        status: 'draft',
        targetTokens: text('todavía sin confirmar'),
      }),
      segment({ id: 3, ord: 2, status: 'confirmed', targetTokens: text('hoy') }),
    ];
    const result = confirmedTargetContext(segments, 3);
    // Segment 2 is skipped entirely, so 1 and 3 become direct neighbours.
    expect(result.get(3)).toEqual({ prevHash: hashOf('Hola'), nextHash: null });
    expect(result.get(1)).toEqual({ prevHash: null, nextHash: hashOf('hoy') });
    expect(result.has(2)).toBe(false);
  });

  it('excludes a confirmed segment with a null target (should not happen, but never crashes on it)', () => {
    const segments = [
      segment({ id: 1, ord: 0, status: 'confirmed', targetTokens: null }),
      segment({ id: 2, ord: 1, status: 'confirmed', targetTokens: text('mundo') }),
    ];
    const result = confirmedTargetContext(segments, 2);
    expect(result.get(2)).toEqual({ prevHash: null, nextHash: null });
  });

  it('skips a locked segment as a neighbour, same as documentContext', () => {
    const segments = [
      segment({ id: 1, ord: 0, status: 'confirmed', targetTokens: text('Hola') }),
      segment({ id: 2, ord: 1, locked: true, targetTokens: null }),
      segment({ id: 3, ord: 2, status: 'confirmed', targetTokens: text('hoy') }),
    ];
    const result = confirmedTargetContext(segments, 3);
    expect(result.get(3)).toEqual({ prevHash: hashOf('Hola'), nextHash: null });
  });
});
