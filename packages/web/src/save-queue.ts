/**
 * Target writes, one segment at a time (v1-spec.md §7.2). The server
 * refuses a write over a version of the segment it did not see
 * (`baseUpdatedAt`), which protects a translator's work from another tab
 * — and would refuse this tab's own second write too, if it left before
 * the first came back. So each segment has at most one write in flight:
 * a later one waits, only the latest waiting one is sent, and each is
 * sent with the version the previous answer returned.
 *
 * Pure of React and fetch — `send` does the request — so the ordering
 * is tested in node (`save-queue.test.ts`).
 */
import type { QaIssue, Segment, Token } from '@cat-tool/core';

export interface SaveResult {
  readonly segment: Segment;
  /** The segments whose QA reran with the write, and their issues now. */
  readonly rerun: readonly number[];
  readonly issues: readonly QaIssue[];
}

export interface SaveQueueDeps {
  /** Sends one write; `urgent` when the page is going away (keepalive). */
  readonly send: (
    segmentId: number,
    tokens: readonly Token[],
    baseUpdatedAt: string | undefined,
    urgent: boolean,
  ) => Promise<SaveResult>;
  /** The version of a segment this page loaded, before any write of its own. */
  readonly loadedVersion: (segmentId: number) => string | undefined;
  readonly onSaved: (segmentId: number, result: SaveResult) => void;
  readonly onFailed: (segmentId: number, error: unknown) => void;
}

export interface SaveQueue {
  save(segmentId: number, tokens: readonly Token[], urgent?: boolean): void;
}

export function createSaveQueue(deps: SaveQueueDeps): SaveQueue {
  const inFlight = new Set<number>();
  const waiting = new Map<number, readonly Token[]>();
  const versions = new Map<number, string | undefined>();
  const versionOf = (id: number) =>
    versions.has(id) ? versions.get(id) : deps.loadedVersion(id);

  const start = (id: number, tokens: readonly Token[], urgent: boolean) => {
    inFlight.add(id);
    deps
      .send(id, tokens, versionOf(id), urgent)
      .then(
        (result) => {
          versions.set(id, result.segment.updatedAt);
          deps.onSaved(id, result);
        },
        (error: unknown) => deps.onFailed(id, error),
      )
      .finally(() => {
        inFlight.delete(id);
        const next = waiting.get(id);
        if (next) {
          waiting.delete(id);
          start(id, next, false);
        }
      });
  };

  return {
    save(id, tokens, urgent = false) {
      // A page going away cannot wait its turn: send now, and take the
      // chance of a conflict over the certainty of losing the edit.
      if (inFlight.has(id) && !urgent) waiting.set(id, tokens);
      else start(id, tokens, urgent);
    },
  };
}
