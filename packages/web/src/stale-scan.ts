/**
 * What the stale-work check says on the Memories screen (backlog #116;
 * `smart-glossary-spec.md` §6.2): the job as the API describes it, one line for
 * each state, the report's summary and a row's words. Pure, so it is tested in
 * node; the component only polls and draws. The matcher and the rule of what
 * counts as stale are the server's: nothing here decides either.
 */

/** One unit that uses an old rendering of one term, as `GET /api/jobs/:id` returns it. */
export interface StaleRowView {
  readonly tuUuid: string;
  readonly source: string;
  readonly target: string;
  readonly termId: number;
  readonly term: string;
  readonly kind: 'forbidden' | 'missing_preferred';
  readonly preferred: string | null;
  readonly found: string | null;
}

export interface StaleScanResult {
  readonly entries: number;
  readonly scanned: number;
  readonly total: number;
  readonly rows: readonly StaleRowView[];
  readonly truncated: boolean;
  readonly complete: boolean;
}

export interface ScanJob {
  readonly id: string;
  readonly kind: 'scan';
  /** The memory being read. */
  readonly tm: string;
  readonly state: 'running' | 'done' | 'failed' | 'cancelled';
  readonly progress: {
    readonly stage: string;
    readonly fraction: number | null;
    readonly units: number | null;
  } | null;
  readonly result: StaleScanResult | null;
  readonly error: string | null;
}

export const isScanFinished = (job: ScanJob): boolean => job.state !== 'running';

const n = (value: number): string => value.toLocaleString('en');

/** One line for a scan, whatever state it is in. */
export function describeScan(job: ScanJob): string {
  switch (job.state) {
    case 'running': {
      const p = job.progress;
      if (!p) return 'Starting…';
      const pct =
        p.fraction === null || Number.isNaN(p.fraction)
          ? null
          : Math.max(0, Math.min(100, Math.floor(p.fraction * 100)));
      const parts = [pct === null ? 'Scanning…' : `Scanning… ${pct}%`];
      if (p.units !== null && p.units > 0) parts.push(`${n(p.units)} units`);
      return parts.join(' · ');
    }
    case 'done':
      return job.result ? scanSummary(job.result) : 'Done.';
    case 'cancelled':
      return 'Scan cancelled.';
    case 'failed':
      return job.error ?? 'The scan failed.';
  }
}

/**
 * What a finished report says, first line first. An empty glossary for the pair is
 * its own message: nothing was read, and "none found" would claim a clean memory.
 */
export function scanSummary(
  result: StaleScanResult,
  pair: { readonly srcLang: string; readonly tgtLang: string } | null = null,
): string {
  if (result.entries === 0) {
    return `The glossary has no terms for ${pair ? `${pair.srcLang} → ${pair.tgtLang}` : 'this pair'}, so there is nothing to check against.`;
  }
  const read = `${n(result.scanned)} ${result.scanned === 1 ? 'unit' : 'units'} read`;
  const stopped = result.complete ? '' : ' (stopped early: the rest was not read)';
  if (result.total === 0) {
    return `No unit uses an old rendering — ${read}${stopped}.`;
  }
  const found = `${n(result.total)} ${result.total === 1 ? 'use' : 'uses'} of an old or forbidden rendering`;
  const shown = result.truncated ? ` Showing the first ${n(result.rows.length)}.` : '';
  return `${found} in ${read}${stopped}.${shown}`;
}

/** A row's finding in words: what the target uses, and what the glossary prefers now. */
export function rowFinding(row: StaleRowView): string {
  if (row.kind === 'forbidden') {
    return (
      `uses the forbidden “${row.found ?? ''}”` +
      (row.preferred ? `; prefers “${row.preferred}”` : '')
    );
  }
  return `uses “${row.found ?? ''}”; prefers “${row.preferred ?? ''}”`;
}

/**
 * The ordered pairs a memory's languages offer, `en de` giving `en → de` and
 * `de → en` (the glossary is read in the pair's direction, so they differ).
 * Empty for a memory with fewer than two languages: nothing to check a pair of.
 */
export function pairChoices(
  langs: readonly string[],
): Array<{ srcLang: string; tgtLang: string }> {
  const out: Array<{ srcLang: string; tgtLang: string }> = [];
  for (const srcLang of langs) {
    for (const tgtLang of langs) if (srcLang !== tgtLang) out.push({ srcLang, tgtLang });
  }
  return out;
}

export const pairKey = (p: { srcLang: string; tgtLang: string }): string =>
  `${p.srcLang}>${p.tgtLang}`;
