/**
 * Embeddings for TM retrieval (tm-format-spec.md §2.8,
 * semantic-matching-spec.md §3.3): the pure half. What a `tuv_vec.model`
 * value names, the one function that spells it, the `Embedder` a shell
 * implements, and the vector's on-disk encoding.
 *
 * Loading model weights is I/O, so no implementation lives here — the
 * `NotificationService`/`SmtpNotificationService` split again.
 */

import { NORMALIZER_VERSION } from './normalize.js';

/**
 * Everything that changes a vector for the same text. Two vectors are
 * comparable only if every field is equal, which is why they all go
 * into {@link embeddingModelKey} and none is left to a default.
 */
export interface EmbeddingModel {
  /** Model repository, e.g. `Xenova/multilingual-e5-small`. */
  readonly repo: string;
  /** The repository revision the weights came from (a commit, not a branch). */
  readonly revision: string;
  /** Weight precision the runtime loaded, e.g. `q8`, `fp32`. */
  readonly dtype: string;
  readonly pooling: 'mean' | 'cls';
  /** Prepended to every text before embedding; `''` for none. */
  readonly prefix: string;
  readonly dim: number;
}

/**
 * The `tuv_vec.model` value for `model` — its single definition.
 *
 * It also names what was embedded: `tuv.plain` under this
 * `NORMALIZER_VERSION`, L2-normalised. A vector written under one key is
 * never compared with, or stored as, another key's (§2.8).
 */
export function embeddingModelKey(model: EmbeddingModel): string {
  if (!/^[0-9a-f]{7,40}$/.test(model.revision)) {
    throw new RangeError(`revision must be a commit hash, got "${model.revision}"`);
  }
  if (!Number.isInteger(model.dim) || model.dim <= 0) {
    throw new RangeError(`dim must be a positive integer, got ${model.dim}`);
  }
  return [
    `${model.repo}@${model.revision}`,
    model.dtype,
    model.pooling,
    `prefix=${JSON.stringify(model.prefix)}`,
    `dim=${model.dim}`,
    'l2',
    `plain/nv${NORMALIZER_VERSION}`,
  ].join(';');
}

/** Turns texts into L2-normalised vectors of `model.dim` floats. */
export interface Embedder {
  readonly model: EmbeddingModel;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

/** `tuv_vec.vec`: float32, little-endian, `dim * 4` bytes (§2.8). */
export function encodeVector(vec: Float32Array): Uint8Array {
  const out = new Uint8Array(vec.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < vec.length; i++) view.setFloat32(i * 4, vec[i]!, true);
  return out;
}

/** Inverse of {@link encodeVector}; refuses a blob of the wrong length. */
export function decodeVector(blob: Uint8Array, dim: number): Float32Array {
  if (blob.byteLength !== dim * 4) {
    throw new RangeError(`vector blob is ${blob.byteLength} bytes, expected ${dim * 4}`);
  }
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}
