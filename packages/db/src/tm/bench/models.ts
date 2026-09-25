/**
 * The embedding models E-001 compares — its setup table
 * (research/semantic-matching/experiments/E-001-shortlist-recall.md),
 * as code. Revisions are the Hugging Face commits the setup pinned.
 */

import type { EmbeddingModel } from '@cat-tool/core';

export const E001_MODELS = {
  e5s: {
    repo: 'Xenova/multilingual-e5-small',
    revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    dtype: 'q8',
    pooling: 'mean',
    // The model card's prefix for symmetric tasks, on both sides.
    prefix: 'query: ',
    dim: 384,
  },
  minilm: {
    repo: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    revision: '2c4055b12046f11709e9df2c122e59ffbdc2f900',
    dtype: 'q8',
    pooling: 'mean',
    prefix: '',
    dim: 384,
  },
  labse: {
    repo: 'Xenova/LaBSE',
    revision: '147002d501fc76ecd313c631999ea796520fea74',
    dtype: 'q8',
    // The export lacks sentence-transformers' final dense layer (E-001).
    pooling: 'cls',
    prefix: '',
    dim: 768,
  },
} as const satisfies Record<string, EmbeddingModel>;

export type E001ModelKey = keyof typeof E001_MODELS;
