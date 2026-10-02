/**
 * The bulk operations that run off the request thread (tm-format-spec.md
 * §1.1, backlog #16a). One table, closed: a job names an operation by a
 * string and passes JSON, so nothing a caller sends is ever a function or
 * a connection — a `better-sqlite3` handle cannot cross to another thread
 * anyway, so each operation opens its own from a path and closes it.
 *
 * An operation registers here when it exists and is bulk. TMX import,
 * `.sdltm` import, merge and `VACUUM` do; rehash-on-normalizer-bump and
 * batch find-and-replace, which §1.1 also lists, are not written yet and
 * join through this table when they are, unchanged for the runner.
 */

import { copyFileSync } from 'node:fs';
import { basename } from 'node:path';

import type { AuditActor } from '@cat-tool/core';

import { Cancelled } from '../cancelled.js';
import { importSdltm, type ImportSdltmResult } from '../tm/import-sdltm.js';
import { importTmxFile, type ImportTmxResult } from '../tm/import-tmx.js';
import { mergeTm, type MergeTmResult } from '../tm/merge.js';
import { describeTm, openTm, type TmSummary } from '../tm/index.js';

/** What a running operation tells the world. `fraction` is null when it cannot say. */
export interface JobProgress {
  /** Names the step, for a person: "importing", "merging unit attributes". */
  readonly stage: string;
  readonly fraction: number | null;
  /** Units written so far, for operations that count them. */
  readonly units: number | null;
}

/** What the runner gives an operation: a way to report, and a way to be told to stop. */
export interface JobContext {
  progress(progress: JobProgress): void;
  stopRequested(): boolean;
}

/**
 * An import's result, and what the new memory is. The summary is taken
 * here, on the worker, while the memory is open: asking for it afterwards
 * means opening it on the caller's thread, and an open runs
 * `integrity_check` (§10), which took 7.9 s on a 500,000-unit memory — the
 * whole request thread, at the moment the import finished.
 */
export type WithSummary<R> = R & { readonly summary: TmSummary };

/** An operation's outcome. `cancelled` is a stop that ended it cleanly, `value` what it has. */
export interface OpOutcome<R> {
  readonly value: R;
  readonly cancelled: boolean;
}

export interface OpTable {
  'tm.importTmx': {
    args: {
      /** The `.ctm` to import into; created by the caller. */
      readonly tmPath: string;
      readonly sourcePath: string;
      readonly sourceName?: string;
      readonly batchSize?: number;
      readonly resume?: number;
    };
    result: WithSummary<ImportTmxResult>;
  };
  'tm.importSdltm': {
    args: { readonly tmPath: string; readonly sourcePath: string };
    result: WithSummary<ImportSdltmResult>;
  };
  'tm.merge': {
    args: {
      readonly tmPath: string;
      readonly sourcePath: string;
      readonly actor: AuditActor;
    };
    result: MergeTmResult;
  };
  'tm.vacuum': {
    args: { readonly tmPath: string };
    result: {
      readonly bytesBefore: number;
      readonly bytesAfter: number;
      /** The backup taken first (§10), by file name: it sits beside the memory. */
      readonly backup: string;
    };
  };
}

export type OpName = keyof OpTable;

type Ops = {
  [K in OpName]: (
    args: OpTable[K]['args'],
    ctx: JobContext,
  ) => OpOutcome<OpTable[K]['result']>;
};

/** Opens a memory for the length of one operation, and closes it however that ends. */
function withTm<T>(path: string, fn: (db: ReturnType<typeof openTm>) => T): T {
  const db = openTm(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export const OPS: Ops = {
  'tm.importTmx': (args, ctx) =>
    withTm(args.tmPath, (db) => {
      const value = importTmxFile(db, args.sourcePath, {
        ...(args.sourceName !== undefined ? { sourceName: args.sourceName } : {}),
        ...(args.batchSize !== undefined ? { batchSize: args.batchSize } : {}),
        ...(args.resume !== undefined ? { resume: args.resume } : {}),
        onProgress: (p) =>
          ctx.progress({
            stage: 'importing',
            fraction: p.bytesTotal > 0 ? p.bytesRead / p.bytesTotal : null,
            units: p.unitsDone,
          }),
        shouldStop: () => ctx.stopRequested(),
      });
      return {
        value: { ...value, summary: describeTm(db) },
        cancelled: !value.complete,
      };
    }),

  // One transaction and no checkpoints of its own: all-or-nothing, so a
  // cancel is the runner's terminate and the rollback is SQLite's.
  'tm.importSdltm': (args, ctx) =>
    withTm(args.tmPath, (db) => {
      ctx.progress({ stage: 'importing', fraction: null, units: null });
      const value = importSdltm(db, args.sourcePath);
      return { value: { ...value, summary: describeTm(db) }, cancelled: false };
    }),

  'tm.merge': (args, ctx) =>
    withTm(args.tmPath, (db) => {
      try {
        const value = mergeTm(db, args.sourcePath, {
          actor: args.actor,
          onPhase: (p) =>
            ctx.progress({
              stage: p.name,
              fraction: (p.step - 1) / p.steps,
              units: null,
            }),
          shouldStop: () => ctx.stopRequested(),
        });
        return { value, cancelled: false };
      } catch (err) {
        if (err instanceof Cancelled) {
          // Rolled back inside `mergeTm`; the destination is as it was.
          return { value: EMPTY_MERGE, cancelled: true };
        }
        throw err;
      }
    }),

  // §10: compaction is explicit, and always preceded by a backup. A VACUUM
  // is one atomic statement, so a cancel that ends the thread leaves the
  // memory whole either way — but it cannot interrupt the statement, so a
  // compaction already running finishes; cancelling stops the waiting.
  'tm.vacuum': (args, ctx) =>
    withTm(args.tmPath, (db) => {
      ctx.progress({ stage: 'backing up', fraction: null, units: null });
      db.pragma('wal_checkpoint(TRUNCATE)'); // so the copy is the whole file, nothing left in the WAL
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = `${args.tmPath}.bak-vacuum-${stamp}`;
      copyFileSync(args.tmPath, backup);
      ctx.progress({ stage: 'compacting', fraction: null, units: null });
      const size = () =>
        (db.pragma('page_count', { simple: true }) as number) *
        (db.pragma('page_size', { simple: true }) as number);
      const bytesBefore = size();
      db.exec('VACUUM');
      return {
        value: { bytesBefore, bytesAfter: size(), backup: basename(backup) },
        cancelled: false,
      };
    }),
};

const EMPTY_MERGE: MergeTmResult = {
  unitsAdded: 0,
  tombstonesPropagated: 0,
  variantsAdded: 0,
  variantsReplaced: 0,
  variantsKept: 0,
  historyRetained: 0,
  historyCopied: 0,
  historyConflicts: 0,
  warnings: [],
};
