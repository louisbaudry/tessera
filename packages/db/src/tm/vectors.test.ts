import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { embeddingModelKey } from '@cat-tool/core';
import type { EmbeddingModel, TmToken } from '@cat-tool/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createTm } from './index.js';
import { loadVectors, topByDot, unembeddedVariants, writeVectors } from './vectors.js';
import { writeBack } from './write.js';

let dir: string;
const dbPath = () => {
  dir = mkdtempSync(join(tmpdir(), 'cat-tm-vec-'));
  return join(dir, 'memory.ctm');
};

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const text = (v: string): TmToken[] => [{ t: 'text', v }];

const M2: EmbeddingModel = {
  repo: 'test/model',
  revision: 'abc1234',
  dtype: 'fp32',
  pooling: 'mean',
  prefix: '',
  dim: 2,
};
const OTHER: EmbeddingModel = { ...M2, revision: 'def5678' };

function memory(pairs: Array<[string, string]>) {
  const db = createTm(dbPath(), { name: 'x', generator: 'test' });
  for (const [en, es] of pairs) {
    writeBack(db, {
      source: { lang: 'en-US', tokens: text(en) },
      target: { lang: 'es', tokens: text(es) },
    });
  }
  return db;
}

function sourceIds(db: ReturnType<typeof memory>): number[] {
  return (
    db.prepare("SELECT id FROM tuv WHERE lang = 'en-US' ORDER BY id").all() as Array<{
      id: number;
    }>
  ).map((r) => r.id);
}

describe('unembeddedVariants', () => {
  it('lists source variants without a vector for this model, region-insensitively, in id order', () => {
    const db = memory([
      ['One', 'Uno'],
      ['Two', 'Dos'],
      ['Three', 'Tres'],
    ]);
    const ids = sourceIds(db);
    writeVectors(db, M2, [{ tuvId: ids[1]!, vec: new Float32Array([1, 0]) }]);

    const todo = unembeddedVariants(db, { model: M2, lang: 'en', limit: 10 });
    expect(todo).toEqual([
      { tuvId: ids[0], plain: 'One' },
      { tuvId: ids[2], plain: 'Three' },
    ]);
    // Another model's vector does not count.
    expect(unembeddedVariants(db, { model: OTHER, lang: 'en', limit: 10 })).toHaveLength(
      3,
    );
    // Batches resume after an id.
    expect(
      unembeddedVariants(db, { model: M2, lang: 'en', afterId: ids[0], limit: 1 }),
    ).toEqual([{ tuvId: ids[2], plain: 'Three' }]);
    db.close();
  });
});

describe('writeVectors / loadVectors', () => {
  it('stores float32 under the model key and loads only that model', () => {
    const db = memory([
      ['One', 'Uno'],
      ['Two', 'Dos'],
    ]);
    const [a, b] = sourceIds(db) as [number, number];
    writeVectors(db, M2, [
      { tuvId: a, vec: new Float32Array([1, 0]) },
      { tuvId: b, vec: new Float32Array([0, 1]) },
    ]);
    writeVectors(db, OTHER, [{ tuvId: a, vec: new Float32Array([0.5, 0.5]) }]);

    const row = db
      .prepare('SELECT model, dim, length(vec) AS n FROM tuv_vec LIMIT 1')
      .get();
    expect(row).toEqual({ model: embeddingModelKey(M2), dim: 2, n: 8 });

    const set = loadVectors(db, { model: M2, lang: 'en-GB' });
    expect([...set.ids]).toEqual([a, b]);
    expect([...set.data]).toEqual([1, 0, 0, 1]);
    expect(loadVectors(db, { model: OTHER, lang: 'en' }).ids).toHaveLength(1);
    expect(loadVectors(db, { model: M2, lang: 'es' }).ids).toHaveLength(0);
    db.close();
  });

  it('refuses a vector whose length is not the model dimension, writing none of the batch', () => {
    const db = memory([['One', 'Uno']]);
    const [a] = sourceIds(db) as [number];
    expect(() =>
      writeVectors(db, M2, [
        { tuvId: a, vec: new Float32Array([1, 0]) },
        { tuvId: a, vec: new Float32Array([1, 0, 0]) },
      ]),
    ).toThrow(RangeError);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tuv_vec').get()).toEqual({ n: 0 });
    db.close();
  });
});

describe('writeBack and tuv_vec', () => {
  it('drops a variant’s vectors when its text changes, and keeps them when it does not', () => {
    const db = memory([['Hello', 'Hola']]);
    const tgt = (
      db.prepare("SELECT id FROM tuv WHERE lang = 'es'").get() as { id: number }
    ).id;
    const src = sourceIds(db)[0]!;
    writeVectors(db, M2, [
      { tuvId: src, vec: new Float32Array([1, 0]) },
      { tuvId: tgt, vec: new Float32Array([0, 1]) },
    ]);

    // Same texts again: nothing changed, nothing dropped.
    writeBack(db, {
      source: { lang: 'en-US', tokens: text('Hello') },
      target: { lang: 'es', tokens: text('Hola') },
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tuv_vec').get()).toEqual({ n: 2 });

    // A new target text: its vector described the old one.
    writeBack(db, {
      source: { lang: 'en-US', tokens: text('Hello') },
      target: { lang: 'es', tokens: text('Buenas') },
    });
    const left = db.prepare('SELECT tuv_id FROM tuv_vec').all();
    expect(left).toEqual([{ tuv_id: src }]);
    db.close();
  });
});

describe('topByDot', () => {
  const set = {
    dim: 2,
    ids: new Int32Array([10, 20, 30, 40]),
    data: new Float32Array([1, 0, 0, 1, 0.6, 0.8, -1, 0]),
  };

  it('returns the m best rows by dot product, best first', () => {
    expect(topByDot(set, new Float32Array([1, 0]), 2)).toEqual([
      { tuvId: 10, score: 1 },
      { tuvId: 30, score: expect.closeTo(0.6, 6) },
    ]);
  });

  it('returns every row when m exceeds the set, and none for m = 0', () => {
    expect(topByDot(set, new Float32Array([0, 1]), 10).map((r) => r.tuvId)).toEqual([
      20, 30, 10, 40,
    ]);
    expect(topByDot(set, new Float32Array([0, 1]), 0)).toEqual([]);
  });

  it('refuses a query of the wrong dimension', () => {
    expect(() => topByDot(set, new Float32Array([1, 0, 0]), 1)).toThrow(RangeError);
  });
});
