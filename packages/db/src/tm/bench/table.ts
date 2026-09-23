/**
 * Renders `results.json` from `run.ts` as the markdown tables in
 * tm-format-spec.md §11. `run.ts` calls it at the end of a run; it can
 * also be pointed at an earlier results file:
 *
 *   node --experimental-strip-types packages/db/src/tm/bench/table.ts results.json
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Summary } from './stats.ts';

interface Lookup {
  readonly all: Summary;
  readonly hitsFound: number;
  readonly hit: Summary;
}

interface Measured {
  readonly size: number;
  /** Absent in results from before the `.sdltm` mode existed. */
  readonly source?: 'synthetic' | 'sdltm';
  readonly langs?: readonly string[];
  readonly tuvCount: number;
  readonly build: {
    readonly ms: number;
    readonly peakRssMiB: number;
    readonly method?: string;
  };
  readonly sizeBytes: number;
  readonly sizeAfterVacuum: number;
  readonly vacuumMs: number;
  readonly exact: {
    readonly retrievePair: Lookup;
    readonly retrievePairAfterAnalyze: Lookup & { readonly analyzeMs: number };
    readonly candidate: Lookup;
  };
  readonly concordance: Record<
    string,
    { readonly ranked: Summary; readonly first50: Summary }
  >;
  readonly writeBackMs: Summary;
  readonly fuzzy: {
    readonly naive: Summary;
    readonly shortlistAllTerms: { readonly ms: Summary; readonly recall: number };
    readonly shortlistNoStopwords: { readonly ms: Summary; readonly recall: number };
  };
  readonly copyMs: number;
  readonly backupMs: number;
  readonly peakRssMiB: number;
}

interface Probe {
  readonly ok: boolean;
  readonly tmxBytes: number;
  readonly totalMs: number;
  readonly peakRssMiB: number;
  readonly error?: string;
}

export interface BenchResults {
  readonly machine: Record<string, string | number>;
  readonly results: ReadonlyArray<{
    readonly size: number;
    readonly sdltmBytes?: number;
    readonly importProbe: Probe | null;
    /** A child that died (e.g. out of memory) reports `{ ok: false, error }` instead. */
    readonly measured: Measured | { readonly ok: false; readonly error: string };
  }>;
}

const units = (n: number): string =>
  n >= 1e6 ? `${n / 1e6}M` : n >= 1e3 ? `${n / 1e3}k` : String(n);
const mib = (b: number): string => `${Math.round(b / 2 ** 20).toLocaleString('en')} MiB`;
const ms = (x: number): string =>
  !Number.isFinite(x)
    ? '—'
    : x >= 10_000
      ? `${(x / 1000).toFixed(0)} s`
      : x >= 1000
        ? `${(x / 1000).toFixed(1)} s`
        : x >= 10
          ? `${x.toFixed(0)} ms`
          : x >= 1
            ? `${x.toFixed(1)} ms`
            : `${x.toFixed(2)} ms`;
const pp = (s: Summary): string => `${ms(s.p50)} / ${ms(s.p99)}`;
const pct = (x: number): string => `${Math.round(x * 100)}%`;

const measuredOk = (x: BenchResults['results'][number]['measured']): x is Measured =>
  'exact' in x;

const label = (size: number, x: Measured): string =>
  x.source === 'sdltm'
    ? `${units(x.size)} (real \`.sdltm\`${x.langs ? `, ${x.langs.join('→')}` : ''})`
    : units(size);

export function markdownTables(r: BenchResults): string {
  const m = r.machine;
  const ok = r.results.flatMap((row) =>
    measuredOk(row.measured) ? [{ ...row, measured: row.measured }] : [],
  );
  const lines: string[] = [];
  lines.push(
    `Machine: ${String(m['cpu'])}, ${String(m['cores'])} cores, ${String(m['memGiB'])} GiB RAM, ` +
      `${String(m['os'])}, Node ${String(m['node'])}, SQLite ${String(m['sqlite'])}.`,
    '',
    '| Units | File | After VACUUM (time) | Build (how, peak RSS) | Single-file `importTmx` (TMX size, peak RSS) | Copy | Online backup |',
    '|---|---|---|---|---|---|---|',
  );
  for (const { size, sdltmBytes, importProbe: p, measured: x } of r.results) {
    if (!measuredOk(x)) {
      lines.push(`| ${units(size)} | **run failed**: ${x.error} | | | | | |`);
      continue;
    }
    const probe =
      sdltmBytes !== undefined
        ? `n/a (source was a ${mib(sdltmBytes)} \`.sdltm\`)`
        : p === null
          ? 'not run'
          : p.ok
            ? `${ms(p.totalMs)} (${mib(p.tmxBytes)}, ${Math.round(p.peakRssMiB)} MiB)`
            : `**fails** after ${ms(p.totalMs)} (${mib(p.tmxBytes)}): ${p.error ?? ''}`;
    lines.push(
      `| ${label(size, x)} | ${mib(x.sizeBytes)} | ${mib(x.sizeAfterVacuum)} (${ms(x.vacuumMs)}) | ` +
        `${ms(x.build.ms)} (${x.build.method ?? 'importTmx, 50,000-unit slices'}, ` +
        `${Math.round(x.build.peakRssMiB)} MiB) | ${probe} | ` +
        `${ms(x.copyMs)} | ${ms(x.backupMs)} |`,
    );
  }
  lines.push(
    '',
    'Latency, p50 / p99 (samples):',
    '',
    '| Units | Exact: `retrievePair` as shipped | Exact: same, after `ANALYZE` | Exact: index-friendly rewrite | Concordance, common word | Concordance, rare word | Concordance, 2-word phrase | `writeBack` (one confirm) |',
    '|---|---|---|---|---|---|---|---|',
  );
  for (const { size, measured: x } of ok) {
    const e = x.exact;
    const c = x.concordance;
    const conc = (k: string): string =>
      c[k] ? `${pp(c[k].ranked)} ranked; ${pp(c[k].first50)} unranked` : '—';
    lines.push(
      `| ${label(size, x)} | ${pp(e.retrievePair.all)} (${e.retrievePair.all.n}) | ` +
        `${pp(e.retrievePairAfterAnalyze.all)} (${e.retrievePairAfterAnalyze.all.n}; ANALYZE ${ms(e.retrievePairAfterAnalyze.analyzeMs)}) | ` +
        `${pp(e.candidate.all)} (${e.candidate.all.n}) | ${conc('common')} | ${conc('rare')} | ${conc('phrase')} | ` +
        `${pp(x.writeBackMs)} (${x.writeBackMs.n}) |`,
    );
  }
  lines.push(
    '',
    'Fuzzy baselines, per query sentence, p50 / p99 (queries); recall = the shortlist contained the best match the naive scan found:',
    '',
    '| Units | Naive: score every source variant | FTS top-50, all query words | FTS top-50, stopwords dropped |',
    '|---|---|---|---|',
  );
  for (const { size, measured: x } of ok) {
    const f = x.fuzzy;
    lines.push(
      `| ${label(size, x)} | ${pp(f.naive)} (${f.naive.n}) | ` +
        `${pp(f.shortlistAllTerms.ms)}, recall ${pct(f.shortlistAllTerms.recall)} | ` +
        `${pp(f.shortlistNoStopwords.ms)}, recall ${pct(f.shortlistNoStopwords.recall)} |`,
    );
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) throw new Error('usage: table.ts <results.json>');
  process.stdout.write(
    `${markdownTables(JSON.parse(readFileSync(file, 'utf8')) as BenchResults)}\n`,
  );
}
