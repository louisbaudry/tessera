/**
 * What the QA panel says about live and deferred QA (issue #361, `planning/v1-spec.md` §7.10):
 * the mode as the server reports it, the one line the panel shows for it, and the words for a
 * sweep job in each state. Pure, so the wording and the rules about when "Run QA" is offered
 * are provable in node; `QaModeBar.tsx` only renders them.
 */

/** `GET /api/projects/:name/qa-mode`. */
export interface QaModeView {
  readonly deferred: boolean;
  /** A deferred project whose findings have not been swept since its last edit. */
  readonly stale: boolean;
  readonly unsweptEdits: number;
}

/** What a finished sweep reports (`QaSweepResult` in `db`). */
export interface QaSweepResult {
  readonly segments: number;
  /** False when an edit landed while it ran: findings are still out of date. */
  readonly current: boolean;
}

/** A sweep job as `GET /api/jobs/:id` returns it. */
export interface QaSweepJob {
  readonly id: string;
  readonly kind: 'qa';
  readonly state: 'running' | 'done' | 'failed' | 'cancelled';
  readonly progress: {
    readonly stage: string;
    readonly fraction: number | null;
    readonly units: number | null;
  } | null;
  readonly result: QaSweepResult | null;
  readonly error: string | null;
}

/** The mode a project has until the server says otherwise: every project before #361. */
export const LIVE_QA: QaModeView = { deferred: false, stale: false, unsweptEdits: 0 };

/** The mode after an edit was saved: a deferred project's findings are then out of date. */
export const afterEdit = (mode: QaModeView): QaModeView =>
  mode.deferred ? { ...mode, stale: true, unsweptEdits: mode.unsweptEdits + 1 } : mode;

/**
 * The page's mode after a sweep finished, from the mode it holds *now* (not the one it held
 * when the sweep started: an edit saved meanwhile has marked it stale since). It reads as
 * current only if the server says so and no edit has been saved here since the sweep began
 * (`startedAtEdits` is the count then); an edit still on its way would otherwise be hidden.
 */
export const afterSweep = (
  latest: QaModeView,
  result: QaSweepResult,
  startedAtEdits: number,
): QaModeView =>
  result.current && latest.unsweptEdits === startedAtEdits
    ? { ...latest, stale: false, unsweptEdits: 0 }
    : latest;

/** Whether the panel offers "Run QA": only a deferred project has anything to catch up on. */
export const canRunQa = (mode: QaModeView): boolean => mode.deferred;

/** The line under the toggle, or null when live QA needs no explaining. */
export function modeLine(mode: QaModeView): string | null {
  if (!mode.deferred) return null;
  return mode.stale
    ? 'QA runs when you ask. The findings below are out of date: run QA before you review or deliver.'
    : 'QA runs when you ask. The findings below are current.';
}

/** Whether a sweep job is still going. */
export const isRunning = (job: QaSweepJob): boolean => job.state === 'running';

const percent = (job: QaSweepJob): number | null => {
  const f = job.progress?.fraction;
  return f === null || f === undefined || Number.isNaN(f)
    ? null
    : Math.max(0, Math.min(100, Math.floor(f * 100)));
};

/** One line for a sweep job, whatever state it is in. */
export function describeSweep(job: QaSweepJob): string {
  switch (job.state) {
    case 'running': {
      const pct = percent(job);
      return pct === null ? 'Running QA…' : `Running QA… ${pct}%`;
    }
    case 'cancelled':
      return 'QA cancelled.';
    case 'failed':
      return job.error ?? 'The QA run failed.';
    case 'done': {
      const r = job.result;
      if (r === null) return 'QA finished.';
      const n = r.segments.toLocaleString('en');
      const segs = `${n} segment${r.segments === 1 ? '' : 's'}`;
      return r.current
        ? `QA checked ${segs}.`
        : `QA checked ${segs}, but you edited meanwhile: run it again for current findings.`;
    }
  }
}
