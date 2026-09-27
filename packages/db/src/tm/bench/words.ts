/**
 * Word lists for concordance, stopwords and fuzzy perturbation, shared
 * by `measure.ts` (E-000's numbers) and `e001.ts`. The synthetic corpus
 * knows its own Zipf ranks; a real memory's are estimated from a
 * sample of its source sentences by document frequency, so "common"
 * and "rare" mean the same thing in both modes.
 *
 * Draws from `rand` in a fixed order, so a caller seeded as E-000 was
 * gets E-000's lists.
 */

import { vocabulary } from './corpus.ts';
import { words } from './stats.ts';

export interface WordLists {
  readonly common: string[];
  readonly rare: string[];
  /** The 100 most frequent words — dropped from an FTS shortlist query. */
  readonly stopwords: Set<string>;
  /** The 2,000 most frequent — what a lexical perturbation substitutes. */
  readonly replacements: string[];
}

export function wordLists(opts: {
  readonly synthetic: boolean;
  readonly rand: () => number;
  readonly sampleSources: (n: number) => ReadonlyArray<{ readonly plain: string }>;
}): WordLists {
  const { rand } = opts;
  if (opts.synthetic) {
    const vocab = vocabulary(1);
    return {
      common: vocab.en.slice(0, 20),
      rare: Array.from({ length: 50 }, () => vocab.en[3000 + Math.floor(rand() * 3000)]!),
      stopwords: new Set(vocab.en.slice(0, 100)),
      replacements: vocab.en.slice(0, 2000),
    };
  }
  const df = new Map<string, number>();
  for (const s of opts.sampleSources(20_000)) {
    for (const w of new Set(words(s.plain))) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const byDf = [...df.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);
  const once = byDf.filter((w) => df.get(w) === 1 && /^\p{L}{4,}$/u.test(w));
  return {
    common: byDf.slice(0, 20),
    rare: Array.from({ length: 50 }, () => once[Math.floor(rand() * once.length)]!),
    stopwords: new Set(byDf.slice(0, 100)),
    replacements: byDf.slice(0, 2000),
  };
}
