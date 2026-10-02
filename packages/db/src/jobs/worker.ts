/**
 * The worker thread's entry (backlog #16a): runs one operation from
 * `ops.ts` against the arguments it was started with, reports progress
 * as messages, and ends with exactly one `done`, `cancelled` or `failed`.
 * `parentPort.postMessage` is queued to the parent, so progress gets out
 * of a synchronous `better-sqlite3` loop without the loop yielding.
 *
 * Cancellation arrives as a flag in shared memory, not a message: a
 * message is only seen when this thread's event loop turns, and an
 * import spends its time inside synchronous batches.
 */

import { parentPort, workerData } from 'node:worker_threads';

import { Cancelled } from '../cancelled.js';
import { OPS, type JobContext, type OpName } from './ops.js';

export interface WorkerStart {
  readonly op: OpName;
  readonly args: unknown;
  /** One `Int32Array` cell: non-zero means "stop at the next safe point". */
  readonly stopFlag: SharedArrayBuffer;
}

export type WorkerMessage =
  | { readonly type: 'progress'; readonly progress: unknown }
  | { readonly type: 'done'; readonly value: unknown }
  | { readonly type: 'cancelled'; readonly value: unknown }
  | { readonly type: 'failed'; readonly name: string; readonly message: string };

const port = parentPort;
if (!port) throw new Error('worker.ts runs as a worker thread, not directly');

const start = workerData as WorkerStart;
const flag = new Int32Array(start.stopFlag);
const post = (message: WorkerMessage): void => port.postMessage(message);

const ctx: JobContext = {
  progress: (progress) => post({ type: 'progress', progress }),
  stopRequested: () => Atomics.load(flag, 0) !== 0,
};

try {
  const op = OPS[start.op] as (
    args: unknown,
    ctx: JobContext,
  ) => { value: unknown; cancelled: boolean };
  if (!op) throw new Error(`unknown operation "${String(start.op)}"`);
  const outcome = op(start.args, ctx);
  post(
    outcome.cancelled
      ? { type: 'cancelled', value: outcome.value }
      : { type: 'done', value: outcome.value },
  );
} catch (err) {
  if (err instanceof Cancelled) {
    post({ type: 'cancelled', value: null });
  } else {
    const e = err instanceof Error ? err : new Error(String(err));
    post({ type: 'failed', name: e.name, message: e.message });
  }
}
