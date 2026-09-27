/**
 * `tuv_vec` reads and writes (tm-format-spec.md §2.8,
 * semantic-matching-spec.md §3.3). A vector is derived data, like
 * `tuv_fts`: recomputable from `tuv.plain`, never exported, and so not
 * an audited write (audit-spec.md §2) — which is why nothing here takes
 * an actor.
 *
 * Every call takes an {@link EmbeddingModel}, never a bare key string,
 * so the `model` column is only ever spelled by `embeddingModelKey`.
 */

import { decodeVector, embeddingModelKey, encodeVector } from '@cat-tool/core';
import type { EmbeddingModel } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { ensurePrimarySubtagFn, matchingLangs } from '../lang-match.js';

export interface VariantText {
  readonly tuvId: number;
  readonly plain: string;
}

/**
 * Up to `limit` variants in `lang` (region-insensitive) that have no
 * vector under `model`, in `tuv.id` order after `afterId` — the unit an
 * embedding pass works through in batches, and resumes from.
 */
export function unembeddedVariants(
  db: Database.Database,
  params: {
    readonly model: EmbeddingModel;
    readonly lang: string;
    readonly afterId?: number;
    readonly limit: number;
  },
): VariantText[] {
  ensurePrimarySubtagFn(db);
  return db
    .prepare<unknown[], VariantText>(
      `SELECT v.id AS tuvId, v.plain AS plain
       FROM   tuv v
       JOIN   tu u ON u.id = v.tu_id AND u.deleted = 0
       WHERE  v.id > @afterId
         AND  v.lang IN ${matchingLangs('tuv', '@lang')}
         AND  NOT EXISTS (SELECT 1 FROM tuv_vec x WHERE x.tuv_id = v.id AND x.model = @model)
       ORDER  BY v.id
       LIMIT  @limit`,
    )
    .all({
      afterId: params.afterId ?? 0,
      lang: params.lang,
      model: embeddingModelKey(params.model),
      limit: params.limit,
    });
}

/** Writes (or replaces) one vector per variant, in one transaction. */
export function writeVectors(
  db: Database.Database,
  model: EmbeddingModel,
  rows: ReadonlyArray<{ readonly tuvId: number; readonly vec: Float32Array }>,
): void {
  const key = embeddingModelKey(model);
  const insert = db.prepare(
    'INSERT OR REPLACE INTO tuv_vec (tuv_id, model, dim, vec) VALUES (?, ?, ?, ?)',
  );
  db.transaction(() => {
    for (const { tuvId, vec } of rows) {
      if (vec.length !== model.dim) {
        throw new RangeError(
          `vector for tuv ${tuvId} has ${vec.length} dimensions, model says ${model.dim}`,
        );
      }
      insert.run(tuvId, key, model.dim, encodeVector(vec));
    }
  })();
}

/** Every vector of one model and language, packed for a linear scan. */
export interface VectorSet {
  readonly dim: number;
  /** `tuv.id` of row `i`. */
  readonly ids: Int32Array;
  /** Row `i` is `data[i * dim .. (i + 1) * dim)`. */
  readonly data: Float32Array;
}

/**
 * Loads all vectors of `model` for variants in `lang` (region-
 * insensitive) into memory. Only vectors written under exactly this
 * model's key come back — the one rule that keeps two models' vectors
 * from ever being compared (§2.8).
 */
export function loadVectors(
  db: Database.Database,
  params: { readonly model: EmbeddingModel; readonly lang: string },
): VectorSet {
  const { dim } = params.model;
  ensurePrimarySubtagFn(db);
  const bind = { model: embeddingModelKey(params.model), lang: params.lang };
  const from = `FROM   tuv_vec x
       JOIN   tuv v ON v.id = x.tuv_id
       JOIN   tu  u ON u.id = v.tu_id AND u.deleted = 0
       WHERE  x.model = @model AND v.lang IN ${matchingLangs('tuv', '@lang')}`;
  const { n } = db
    .prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n ${from}`)
    .get(bind)!;
  const ids = new Int32Array(n);
  const data = new Float32Array(n * dim);
  let i = 0;
  for (const row of db
    .prepare<unknown[], { id: number; vec: Uint8Array }>(
      `SELECT x.tuv_id AS id, x.vec AS vec ${from} ORDER BY x.tuv_id`,
    )
    .iterate(bind)) {
    if (i === n) break;
    ids[i] = row.id;
    data.set(decodeVector(row.vec, dim), i * dim);
    i++;
  }
  return { dim, ids: ids.subarray(0, i), data: data.subarray(0, i * dim) };
}

/**
 * The `m` rows of `set` with the highest dot product with `query` (a
 * cosine, since both sides are L2-normalised), best first — the exact
 * search E-001 measures every approximate one against.
 */
export function topByDot(
  set: VectorSet,
  query: Float32Array,
  m: number,
): Array<{ readonly tuvId: number; readonly score: number }> {
  const { dim, ids, data } = set;
  if (query.length !== dim) {
    throw new RangeError(`query has ${query.length} dimensions, set has ${dim}`);
  }
  const k = Math.min(m, ids.length);
  // Best-so-far kept sorted descending; k is small (tens), so insertion
  // beats a heap.
  const topIdx = new Int32Array(k);
  const topScore = new Float64Array(k).fill(-Infinity);
  for (let r = 0; r < ids.length; r++) {
    let s = 0;
    const base = r * dim;
    for (let j = 0; j < dim; j++) s += data[base + j]! * query[j]!;
    if (k === 0 || s <= topScore[k - 1]!) continue;
    let at = k - 1;
    while (at > 0 && topScore[at - 1]! < s) {
      topScore[at] = topScore[at - 1]!;
      topIdx[at] = topIdx[at - 1]!;
      at--;
    }
    topScore[at] = s;
    topIdx[at] = r;
  }
  return Array.from({ length: k }, (_, i) => ({
    tuvId: ids[topIdx[i]!]!,
    score: topScore[i]!,
  }));
}
