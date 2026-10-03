/**
 * The server's table of running and recently finished bulk jobs
 * (backlog #16a, tm-format-spec.md §1.1). `@cat-tool/db`'s `startJob` runs
 * the work on a worker thread; this keeps what an HTTP client needs of
 * it: an id to poll and cancel by, whose job it is, and how it ended.
 *
 * In memory, and lost with the process, on purpose: what a job leaves on
 * disk never depends on this table (a memory is renamed into place only
 * when its import has completed, so a crash leaves a staging file and no
 * half-memory), and a client that finds its job gone starts it again.
 *
 * A job is the account's: `get` takes the account as well as the id, so
 * another account's id is "no such job", exactly as another account's
 * project is. Ids are unguessable anyway, so the scope is a second lock.
 */

import { randomBytes } from 'node:crypto';

import type { JobHandle, JobOutcome, JobProgress } from '@cat-tool/db';

export type JobState = 'running' | 'done' | 'failed' | 'cancelled';

/** What a job's `onSettled` decides: what to show, after it has cleaned up. */
export type Settled =
  | { readonly state: 'done'; readonly result: unknown }
  | { readonly state: 'failed'; readonly error: string }
  | { readonly state: 'cancelled' };

/** A job as the API shows it: a slug, never a path. */
export interface JobView {
  readonly id: string;
  readonly kind: 'import';
  /** The memory being made. */
  readonly tm: string;
  readonly state: JobState;
  readonly progress: JobProgress | null;
  readonly result: unknown;
  readonly error: string | null;
}

interface Entry {
  readonly id: string;
  readonly accountId: number;
  readonly tm: string;
  readonly handle: JobHandle<unknown>;
  state: JobState;
  result: unknown;
  error: string | null;
  finishedAt: number | null;
}

/** A finished job is kept this long, for a client that polls late. */
const KEEP_FINISHED_MS = 15 * 60 * 1000;
/** Imports running at once, in all. Each is a thread and a connection. */
export const MAX_RUNNING_JOBS = 4;

export class JobRegistry {
  private readonly entries = new Map<string, Entry>();

  /** How many of this account's jobs are running; imports allow one. */
  runningFor(accountId: number): number {
    return [...this.entries.values()].filter(
      (e) => e.accountId === accountId && e.state === 'running',
    ).length;
  }

  running(): number {
    return [...this.entries.values()].filter((e) => e.state === 'running').length;
  }

  /**
   * Registers a started job. `onSettled` runs once the job has ended, with
   * the outcome (or the error it failed with): it does the cleaning up
   * and says what the client sees. A throw from it is a failed job.
   */
  start(params: {
    accountId: number;
    tm: string;
    handle: JobHandle<unknown>;
    onSettled: (result: JobOutcome<unknown> | { failure: Error }) => Settled;
  }): JobView {
    this.prune();
    const entry: Entry = {
      id: randomBytes(16).toString('hex'),
      accountId: params.accountId,
      tm: params.tm,
      handle: params.handle,
      state: 'running',
      result: null,
      error: null,
      finishedAt: null,
    };
    this.entries.set(entry.id, entry);

    const settle = (input: JobOutcome<unknown> | { failure: Error }): void => {
      let settled: Settled;
      try {
        settled = params.onSettled(input);
      } catch (err) {
        settled = {
          state: 'failed',
          error: err instanceof Error ? err.message : String(err),
        };
      }
      entry.state = settled.state;
      if (settled.state === 'done') entry.result = settled.result;
      if (settled.state === 'failed') entry.error = settled.error;
      entry.finishedAt = Date.now();
    };
    params.handle.done.then(settle, (failure: unknown) =>
      settle({
        failure: failure instanceof Error ? failure : new Error(String(failure)),
      }),
    );
    return this.view(entry);
  }

  /** The account's own job, or undefined — another account's id is the same as none. */
  get(accountId: number, id: string): JobView | undefined {
    const entry = this.entries.get(id);
    return entry && entry.accountId === accountId ? this.view(entry) : undefined;
  }

  /** The account's own jobs, running first, then the most recently started. */
  list(accountId: number): JobView[] {
    const own = [...this.entries.values()].filter((e) => e.accountId === accountId);
    // Map order is start order, so reversing puts the newest first and the
    // stable sort keeps that within each group.
    return own
      .reverse()
      .sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running'))
      .map((e) => this.view(e));
  }

  /** Asks the account's job to stop; returns its view, or undefined if it is not theirs. */
  cancel(accountId: number, id: string): JobView | undefined {
    const entry = this.entries.get(id);
    if (!entry || entry.accountId !== accountId) return undefined;
    if (entry.state === 'running') entry.handle.cancel();
    return this.view(entry);
  }

  /** Stops every running job now and waits for the threads to be gone: the process is closing. */
  async shutdown(): Promise<void> {
    const running = [...this.entries.values()].filter((e) => e.state === 'running');
    for (const e of running) e.handle.cancel({ immediately: true });
    await Promise.allSettled(running.map((e) => e.handle.done));
  }

  private view(e: Entry): JobView {
    return {
      id: e.id,
      kind: 'import',
      tm: e.tm,
      state: e.state,
      progress: e.handle.progress(),
      result: e.result,
      error: e.error,
    };
  }

  private prune(): void {
    const cutoff = Date.now() - KEEP_FINISHED_MS;
    for (const [id, e] of this.entries) {
      if (e.finishedAt !== null && e.finishedAt < cutoff) this.entries.delete(id);
    }
  }
}
