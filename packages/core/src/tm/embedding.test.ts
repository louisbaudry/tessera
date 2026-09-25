import { describe, expect, it } from 'vitest';

import {
  decodeVector,
  embeddingModelKey,
  encodeVector,
  type EmbeddingModel,
} from './embedding.js';
import { NORMALIZER_VERSION } from './normalize.js';

const E5: EmbeddingModel = {
  repo: 'Xenova/multilingual-e5-small',
  revision: '761b726',
  dtype: 'q8',
  pooling: 'mean',
  prefix: 'query: ',
  dim: 384,
};

describe('embeddingModelKey', () => {
  it('names every field that changes a vector, and the normalizer version', () => {
    expect(embeddingModelKey(E5)).toBe(
      `Xenova/multilingual-e5-small@761b726;q8;mean;prefix="query: ";dim=384;l2;plain/nv${NORMALIZER_VERSION}`,
    );
  });

  it('differs when any field differs', () => {
    const base = embeddingModelKey(E5);
    for (const change of [
      { revision: '761b727' },
      { dtype: 'fp32' },
      { pooling: 'cls' as const },
      { prefix: '' },
      { dim: 768 },
    ]) {
      expect(embeddingModelKey({ ...E5, ...change })).not.toBe(base);
    }
  });

  it('refuses a branch name as a revision', () => {
    expect(() => embeddingModelKey({ ...E5, revision: 'main' })).toThrow(RangeError);
  });
});

describe('encodeVector / decodeVector', () => {
  it('round-trips float32 little-endian', () => {
    const v = new Float32Array([1, -0.5, 0.25, 3.4028234663852886e38]);
    const blob = encodeVector(v);
    expect(blob.byteLength).toBe(16);
    expect([...blob.slice(0, 4)]).toEqual([0, 0, 0x80, 0x3f]);
    expect([...decodeVector(blob, 4)]).toEqual([...v]);
  });

  it('decodes from an offset view', () => {
    const inner = encodeVector(new Float32Array([2, 4]));
    const padded = new Uint8Array(inner.byteLength + 3);
    padded.set(inner, 3);
    expect([...decodeVector(padded.subarray(3), 2)]).toEqual([2, 4]);
  });

  it('refuses a blob of the wrong length', () => {
    expect(() => decodeVector(new Uint8Array(12), 4)).toThrow(RangeError);
  });
});
