/** Timing and scoring helpers for the `.ctm` scale benchmark. */

export interface Summary {
  readonly n: number;
  readonly p50: number;
  readonly p99: number;
  readonly max: number;
}

/** Milliseconds since `start` (a `process.hrtime.bigint()` value). */
export function msSince(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

export function summarize(samples: readonly number[]): Summary {
  if (samples.length === 0) return { n: 0, p50: NaN, p99: NaN, max: NaN };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
  return {
    n: sorted.length,
    p50: at(0.5),
    p99: at(0.99),
    max: sorted[sorted.length - 1]!,
  };
}

export interface SampleOptions {
  /** Stop after this many calls. */
  readonly max: number;
  /** Never stop before this many, whatever the budget says. */
  readonly min: number;
  /** Stop once this much wall time has passed (and `min` is met). */
  readonly budgetMs: number;
}

/**
 * Times `fn(i)` repeatedly. The budget exists because a query that
 * scans the whole table cannot be run 10,000 times at 5M units inside
 * any reasonable benchmark — the result records how many samples it got.
 */
export function sample(fn: (i: number) => void, opts: SampleOptions): number[] {
  const out: number[] = [];
  const began = process.hrtime.bigint();
  for (let i = 0; i < opts.max; i++) {
    if (i >= opts.min && msSince(began) > opts.budgetMs) break;
    const t = process.hrtime.bigint();
    fn(i);
    out.push(msSince(t));
  }
  return out;
}

/** Peak resident set size of this process so far, in MiB. */
export function peakRssMiB(): number {
  return process.resourceUsage().maxRSS / 1024;
}

/** Lowercased word tokens, the unit a fuzzy scorer compares. */
export function words(plain: string): string[] {
  return plain
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Word-level Levenshtein distance. Word- rather than character-level
 * because that is what a TM fuzzy scorer compares; a character-level
 * one costs roughly (chars/words)^2 ≈ 30× more per comparison.
 *
 * Takes words or interned word ids (`e001.ts`'s naive scan): only
 * equality is compared, so the distance is the same either way.
 */
export function wordDistance(
  a: ArrayLike<string | number>,
  b: ArrayLike<string | number>,
  row: Int32Array,
): number {
  const n = b.length;
  // A typed array ignores out-of-range writes, so a short row would
  // return a wrong distance rather than fail.
  if (row.length <= n) throw new RangeError(`scratch row too short for ${n} words`);
  for (let j = 0; j <= n; j++) row[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0]!;
    row[0] = i;
    const ai = a[i - 1];
    for (let j = 1; j <= n; j++) {
      const up = row[j]!;
      const cost = ai === b[j - 1] ? 0 : 1;
      row[j] = Math.min(up + 1, row[j - 1]! + 1, diag + cost);
      diag = up;
    }
  }
  return row[n]!;
}

/** Fuzzy score in [0, 1]: 1 − distance / longer length. */
export function fuzzyScore(
  a: ArrayLike<string | number>,
  b: ArrayLike<string | number>,
  row: Int32Array,
): number {
  const longer = Math.max(a.length, b.length);
  return longer === 0 ? 1 : 1 - wordDistance(a, b, row) / longer;
}

/**
 * Exact one-sided McNemar test on paired outcomes: `b` pairs where only
 * the tested arm succeeded, `c` where only the control did. Returns
 * P(X ≥ b) for X ~ Binomial(b + c, 1/2) — E-001's test.
 */
export function mcnemarOneSided(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  let logC = 0; // log C(n, k), starting at k = 0
  let p = 0;
  for (let k = 0; k <= n; k++) {
    if (k >= b) p += Math.exp(logC - n * Math.LN2);
    logC += Math.log(n - k) - Math.log(k + 1);
  }
  return Math.min(1, p);
}
