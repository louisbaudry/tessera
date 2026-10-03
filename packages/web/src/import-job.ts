/**
 * What the Memories screen shows of an import running on the server
 * (backlog #16a): the job as the API describes it, and the words and
 * numbers for it. Pure, so it is tested in node; the component only
 * polls and draws.
 */

/** A job as `GET /api/jobs/:id` returns it. */
export interface ImportJob {
  readonly id: string;
  readonly kind: 'import';
  /** The memory being made. */
  readonly tm: string;
  readonly state: 'running' | 'done' | 'failed' | 'cancelled';
  readonly progress: {
    readonly stage: string;
    /** 0..1, or null when the operation cannot say how far it is. */
    readonly fraction: number | null;
    readonly units: number | null;
  } | null;
  /** The new memory and the importer's warnings, once `done`. */
  readonly result: { readonly slug: string; readonly warnings: readonly string[] } | null;
  readonly error: string | null;
}

/** How often the screen asks. Frequent enough to feel live, rare enough to cost nothing. */
export const POLL_MS = 500;

export const isFinished = (job: ImportJob): boolean => job.state !== 'running';

/** A whole percentage, clamped: a file the parser read slightly past its size must not show 101%. */
export function percent(fraction: number | null): number | null {
  if (fraction === null || Number.isNaN(fraction)) return null;
  return Math.max(0, Math.min(100, Math.floor(fraction * 100)));
}

/**
 * One line for a job, whatever state it is in. A cancelled import says
 * what became of what it had read: nothing was kept, because a memory
 * only exists once its import is whole.
 */
export function describeJob(job: ImportJob): string {
  switch (job.state) {
    case 'running': {
      const p = job.progress;
      if (!p) return 'Starting…';
      const pct = percent(p.fraction);
      const parts = [pct === null ? 'Importing…' : `Importing… ${pct}%`];
      if (p.units !== null && p.units > 0)
        parts.push(`${p.units.toLocaleString()} units`);
      return parts.join(' · ');
    }
    case 'done':
      return 'Imported.';
    case 'cancelled':
      return 'Import cancelled — nothing was kept.';
    case 'failed':
      return job.error ?? 'The import failed.';
  }
}

/**
 * The import to pick up again when the screen opens: `GET /api/jobs`
 * lists running ones first, and an account has at most one running
 * import, so the first running job is it. A finished job is not one to
 * resume — its memory is in the list already.
 */
export function findRunning(jobs: readonly ImportJob[]): ImportJob | null {
  return jobs.find((j) => j.state === 'running') ?? null;
}
