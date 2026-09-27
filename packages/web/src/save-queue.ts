/**
 * Target writes, one segment at a time (v1-spec.md §7.2). The server
 * refuses a write over a version of the segment it did not see
 * (`baseUpdatedAt`), which protects a translator's work from another tab
 * — and would refuse this tab's own second write too, if it left before
 * the first came back. So each segment has at most one write in flight:
 * a later one waits, only the latest waiting one is sent, and each is
 * sent with the version the previous answer returned.
 *
 * The one exception is the page going away (`urgent`): that write cannot
 * wait its turn, and the version it would wait for is this tab's own
 * write still in flight. So it goes at once and, when a write of the
 * segment is in flight, with no version at all — sent with the stale one
 * it would be a certain conflict, and the edit lost with the page. What
 * that risks is overwriting another tab's write that got in just before
 * the one in flight, which is the smaller loss.
 *
 * Every answer says whether it is for the latest write the queue was
 * given for that segment: an earlier one's answer is not what the row
 * should show while a later edit is still on its way.
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
  /**
   * Sends one write; `urgent` when the page is going away (keepalive).
   * No `baseUpdatedAt`: write whatever the segment's version.
   */
  readonly send: (
    segmentId: number,
    tokens: readonly Token[],
    baseUpdatedAt: string | undefined,
    urgent: boolean,
  ) => Promise<SaveResult>;
  /** The version of a segment this page loaded, before any write of its own. */
  readonly loadedVersion: (segmentId: number) => string | undefined;
  /** `latest`: no later write of the segment was asked for since this one. */
  readonly onSaved: (segmentId: number, result: SaveResult, latest: boolean) => void;
  readonly onFailed: (segmentId: number, error: unknown, latest: boolean) => void;
}

export interface SaveQueue {
  save(segmentId: number, tokens: readonly Token[], urgent?: boolean): void;
}

export function createSaveQueue(deps: SaveQueueDeps): SaveQueue {
  // Writes are numbered in the order they were asked for.
  let asked = 0;
  const newest = new Map<number, number>();
  const inFlight = new Map<number, number>();
  const waiting = new Map<
    number,
    { readonly tokens: readonly Token[]; readonly n: number }
  >();
  // The version the newest answered write returned; an earlier write's
  // answer arriving after it (an urgent write overtook it) is older.
  const versions = new Map<number, { readonly updatedAt: string; readonly n: number }>();
  const versionOf = (id: number) =>
    versions.has(id) ? versions.get(id)!.updatedAt : deps.loadedVersion(id);

  const start = (
    id: number,
    tokens: readonly Token[],
    n: number,
    base: string | undefined,
    urgent: boolean,
  ) => {
    inFlight.set(id, (inFlight.get(id) ?? 0) + 1);
    deps
      .send(id, tokens, base, urgent)
      .then(
        (result) => {
          if (n > (versions.get(id)?.n ?? 0)) {
            versions.set(id, { updatedAt: result.segment.updatedAt, n });
          }
          deps.onSaved(id, result, newest.get(id) === n);
        },
        (error: unknown) => deps.onFailed(id, error, newest.get(id) === n),
      )
      .finally(() => {
        const left = inFlight.get(id)! - 1;
        if (left > 0) {
          inFlight.set(id, left);
          return;
        }
        inFlight.delete(id);
        const next = waiting.get(id);
        if (next) {
          waiting.delete(id);
          start(id, next.tokens, next.n, versionOf(id), false);
        }
      });
  };

  return {
    save(id, tokens, urgent = false) {
      const n = ++asked;
      newest.set(id, n);
      if (!inFlight.has(id)) start(id, tokens, n, versionOf(id), urgent);
      else if (!urgent) waiting.set(id, { tokens, n });
      else {
        // The page is going away: now, with no version (see above), and
        // what waited is older than this.
        waiting.delete(id);
        start(id, tokens, n, undefined, true);
      }
    },
  };
}
