/**
 * An `Embedder` on `@huggingface/transformers` (transformers.js), local
 * and on CPU, for the bench. The product's implementation belongs in a
 * shell package (semantic-matching-spec.md §3.3); this one exists so
 * E-001 measures the same runtime the product would use.
 */

import type { Embedder, EmbeddingModel } from '@cat-tool/core';
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

/** Texts per forward pass. */
const BATCH = 32;

export async function transformersEmbedder(
  model: EmbeddingModel,
  opts: { readonly cacheDir: string },
): Promise<Embedder> {
  env.cacheDir = opts.cacheDir;
  const extract = (await pipeline('feature-extraction', model.repo, {
    revision: model.revision,
    dtype: model.dtype as 'q8',
  })) as FeatureExtractionPipeline;
  return {
    model,
    async embed(texts) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts.slice(i, i + BATCH).map((t) => model.prefix + t);
        const tensor = await extract(batch, { pooling: model.pooling, normalize: true });
        const [rows, dim] = tensor.dims as [number, number];
        if (dim !== model.dim) {
          throw new Error(
            `${model.repo} returned ${dim} dimensions, expected ${model.dim}`,
          );
        }
        const data = tensor.data as Float32Array;
        for (let r = 0; r < rows; r++) out.push(data.slice(r * dim, (r + 1) * dim));
      }
      return out;
    },
  };
}
