/**
 * A drafting run as a job the registry can poll and cancel (backlog #136;
 * `planning/translation-engine-spec.md` D5, D12, D26).
 *
 * `db`'s `startJob` runs synchronous operations on a worker thread, which a run
 * of network calls cannot be: it waits on Anthropic almost all of its time, so
 * it runs on this thread, in the background, and only its SQLite work (one short
 * read or write per segment) touches the event loop. It still presents the
 * handle the registry holds, so `/api/jobs/:id` polls and cancels it like any
 * other, and a cancelled run ends between segments with what it stored.
 *
 * The run opens its own connection: the request that started it is over and its
 * connection closed. The gate is `engineFor` over the same two files, asked
 * again before every segment, so a consent withdrawn mid-run stops it (D15).
 */

import type { AuditActor, DraftEngineAdapter } from '@cat-tool/core';
import {
  draftSuggestions,
  openProjectDb,
  type DraftSuggestionsSummary,
  type JobHandle,
  type JobProgress,
  type openPlatformDb,
} from '@cat-tool/db';

import { engineFor } from './engine.js';

export interface DraftRunParams {
  readonly platform: ReturnType<typeof openPlatformDb>;
  /** The project owner's account id: whose consent applies. */
  readonly ownerId: number;
  readonly projectPath: string;
  readonly adapter: DraftEngineAdapter;
  /** Who started it. The engine is an origin, never an actor. */
  readonly actor: AuditActor;
  readonly tokenCeiling?: number;
}

/** Starts a run in the background and returns its handle. */
export function startDraftRun(
  params: DraftRunParams,
): JobHandle<DraftSuggestionsSummary> {
  let stopRequested = false;
  let progress: JobProgress | null = null;

  const done = (async () => {
    const db = openProjectDb(params.projectPath);
    try {
      const summary = await draftSuggestions(db, {
        actor: params.actor,
        adapter: params.adapter,
        gate: () => engineFor(params.platform, params.ownerId, db),
        shouldStop: () => stopRequested,
        ...(params.tokenCeiling === undefined
          ? {}
          : { tokenCeiling: params.tokenCeiling }),
        onProgress: (finished, total) => {
          progress = {
            stage: 'drafting',
            fraction: total === 0 ? 1 : finished / total,
            units: finished,
          };
        },
      });
      return summary.stop === 'cancelled'
        ? ({ status: 'cancelled', value: summary, terminated: false } as const)
        : ({ status: 'done', value: summary } as const);
    } finally {
      db.close();
    }
  })();

  return {
    done,
    cancel: () => {
      stopRequested = true;
    },
    progress: () => progress,
  };
}
