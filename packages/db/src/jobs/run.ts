/**
 * Running a bulk operation on a worker thread (tm-format-spec.md §1.1,
 * backlog #16a): `startJob(op, args)` returns at once with a handle; the
 * work happens on another thread, so the caller's event loop — a
 * server's — keeps answering other requests.
 *
 * **Cancel is SQLite's atomicity, not the operation's cooperation.**
 * `cancel()` sets a flag the operation checks at its safe points (between
 * import batches, between merge phases) and so usually ends on its own,
 * cleanly. If it has not by `graceMs` — a single long statement, a
 * `VACUUM`, an `.sdltm` import — the thread is terminated. That is safe
 * for the same reason a power cut is: a transaction that never committed
 * never happened, and the WAL is replayed or discarded at the next open.
 * An import killed this way keeps whole batches and an incomplete
 * `tm_import` row; everything else is all-or-nothing.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { JobProgress, OpName, OpTable } from './ops.js';
import type { WorkerMessage, WorkerStart } from './worker.js';

/** The operation failed (as opposed to being cancelled). `causeName` is the error class it threw. */
export class JobError extends Error {
  constructor(
    message: string,
    readonly causeName: string,
  ) {
    super(message);
    this.name = 'JobError';
  }
}

export type JobOutcome<R> =
  | { readonly status: 'done'; readonly value: R }
  /**
   * Stopped. `value` is what a cooperative stop leaves (an import's counts so far),
   * `null` for a terminated thread or a rolled-back merge, which has none to give.
   */
  | {
      readonly status: 'cancelled';
      readonly value: R | null;
      readonly terminated: boolean;
    };

export interface JobHandle<R> {
  /** Settles with the outcome, or rejects with {@link JobError} if the operation failed. */
  readonly done: Promise<JobOutcome<R>>;
  /**
   * Ask it to stop; see the module comment. Safe to call more than once, or
   * after it ended. `immediately` skips the grace and terminates the thread
   * now — for a process that is going away and has no time to wait.
   */
  cancel(options?: { readonly immediately?: boolean }): void;
  /** The latest progress it reported, or null before the first. */
  progress(): JobProgress | null;
}

export interface StartJobOptions {
  /** How long a cancelled operation gets to stop itself before its thread is terminated. Default 3000 ms. */
  readonly graceMs?: number;
  readonly onProgress?: (progress: JobProgress) => void;
}

export const DEFAULT_GRACE_MS = 3000;

/**
 * The worker's file. Built, it sits beside this one; run from source
 * (vitest, the bench) it is in `dist/`, which must have been built — as
 * `@cat-tool/core`'s `dist/` must for any `db` test to import it.
 */
function workerFile(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, 'worker.js'),
    join(here, '../../dist/jobs/worker.js'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    'the job worker is not built (dist/jobs/worker.js): run `pnpm build` before running jobs from source',
  );
}

export function startJob<K extends OpName>(
  op: K,
  args: OpTable[K]['args'],
  options: StartJobOptions = {},
): JobHandle<OpTable[K]['result']> {
  type R = OpTable[K]['result'];
  const stopFlag = new SharedArrayBuffer(4);
  const flag = new Int32Array(stopFlag);
  const start: WorkerStart = { op, args, stopFlag };
  const worker = new Worker(workerFile(), { workerData: start });

  let latest: JobProgress | null = null;
  let settled = false;
  let graceTimer: NodeJS.Timeout | undefined;
  let cancelRequested = false;
  let terminated = false;

  const done = new Promise<JobOutcome<R>>((resolve, reject) => {
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      fn();
    };
    worker.on('message', (message: WorkerMessage) => {
      switch (message.type) {
        case 'progress':
          latest = message.progress as JobProgress;
          options.onProgress?.(latest);
          return;
        case 'done':
          return settle(() => resolve({ status: 'done', value: message.value as R }));
        case 'cancelled':
          return settle(() =>
            resolve({
              status: 'cancelled',
              value: message.value as R | null,
              terminated: false,
            }),
          );
        case 'failed':
          return settle(() => reject(new JobError(message.message, message.name)));
      }
    });
    worker.on('error', (err) =>
      settle(() => reject(new JobError(err.message, err.name))),
    );
    worker.on('exit', (code) =>
      settle(() => {
        if (terminated)
          return resolve({ status: 'cancelled', value: null, terminated: true });
        reject(
          new JobError(
            `the job's thread ended unexpectedly (exit code ${code})`,
            'Error',
          ),
        );
      }),
    );
  });

  return {
    done,
    progress: () => latest,
    cancel(cancelOptions = {}): void {
      if (settled) return;
      // A second, impatient cancel may still shorten a grace already running.
      if (cancelRequested && !cancelOptions.immediately) return;
      cancelRequested = true;
      Atomics.store(flag, 0, 1);
      const terminate = (): void => {
        if (settled) return;
        terminated = true;
        void worker.terminate();
      };
      const grace = cancelOptions.immediately ? 0 : (options.graceMs ?? DEFAULT_GRACE_MS);
      if (graceTimer) clearTimeout(graceTimer);
      if (grace <= 0) terminate();
      else graceTimer = setTimeout(terminate, grace);
    },
  };
}
