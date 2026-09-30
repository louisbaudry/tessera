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
 * the one in flight, which is the smaller loss. The same holds for every
 * write still waiting when the page goes (`flush`): its editor has closed,
 * and nothing else would send it.
 *
 * Every answer says whether it is for the latest write the queue was
 * given for that segment: an earlier one's answer is not what the row
 * should show while a later edit is still on its way.
 *
 * A confirm (`confirm`, backlog #30) is a write of the segment's status,
 * not of its text, and it approves the text as stored: so it goes after
 * every write of that segment already asked for, with the version the
 * last one returned. It is dropped — never sent — when one of those
 * writes fails (it would approve the text the failed write was meant to
 * replace) and when another write is asked for before it goes (the
 * translator has changed what they confirmed). Neither is silent: the
 * failure is the write's, and a segment edited after confirming is
 * `translated`, which is what it is. The page going away does not send
 * one — a lost confirm costs a keystroke; a lost edit costs the text.
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
  /** `kind` says which request failed: a confirm's failure is not a save's. */
  readonly onFailed: (
    segmentId: number,
    error: unknown,
    latest: boolean,
    kind: 'save' | 'confirm',
  ) => void;
  /**
   * Sends one confirm over the version the segment's last write returned,
   * or the one this page loaded. Its answer goes to `onSaved`.
   */
  readonly confirm: (
    segmentId: number,
    baseUpdatedAt: string | undefined,
  ) => Promise<SaveResult>;
}

export interface SaveQueue {
  save(segmentId: number, tokens: readonly Token[], urgent?: boolean): void;
  /** Confirms the segment once its writes have landed (see above). */
  confirm(segmentId: number): void;
  /**
   * Resolves once no write, waiting write or confirm of any of these
   * segments is left (v1-spec.md §7.4): a merge or split reads the
   * segments *as stored*, so it goes after every write asked for.
   */
  whenIdle(segmentIds: readonly number[]): Promise<void>;
  /** The version of a segment the next write of it goes over. */
  version(segmentId: number): string | undefined;
  /**
   * These segments were replaced or removed by a merge or split: what the
   * queue remembers of them (versions, the newest write) is of rows that
   * no longer read that way, and the page has their new versions.
   */
  forget(segmentIds: readonly number[]): void;
  /**
   * The page is going away: every waiting write goes now, urgent. Called
   * after the open editor's own urgent write, which has already replaced
   * any waiting write of its segment — sent the other way round, the two
   * would race, and the older could land last.
   */
  flush(): void;
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
  // Confirms asked for and not yet sent, by segment.
  const confirming = new Set<number>();
  const idle = (id: number) =>
    !inFlight.has(id) && !waiting.has(id) && !confirming.has(id);
  const idleWaiters: Array<{ ids: readonly number[]; resolve: () => void }> = [];
  const wake = () => {
    for (const waiter of [...idleWaiters]) {
      if (!waiter.ids.every(idle)) continue;
      idleWaiters.splice(idleWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  };

  const drain = (id: number) => {
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
    } else if (confirming.delete(id)) {
      startConfirm(id);
    }
    wake();
  };

  const startConfirm = (id: number) => {
    inFlight.set(id, (inFlight.get(id) ?? 0) + 1);
    // Ordered among the writes for the version, but not one of them for
    // `latest`: a confirm asked for later must not silence a save's failure.
    const n = ++asked;
    const wrote = newest.get(id);
    deps
      .confirm(id, versionOf(id))
      .then(
        (result) => {
          if (n > (versions.get(id)?.n ?? 0)) {
            versions.set(id, { updatedAt: result.segment.updatedAt, n });
          }
          deps.onSaved(id, result, newest.get(id) === wrote);
        },
        (error: unknown) => deps.onFailed(id, error, newest.get(id) === wrote, 'confirm'),
      )
      .finally(() => drain(id));
  };

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
        (error: unknown) => {
          confirming.delete(id);
          deps.onFailed(id, error, newest.get(id) === n, 'save');
        },
      )
      .finally(() => drain(id));
  };

  return {
    whenIdle(ids) {
      if (ids.every(idle)) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push({ ids, resolve }));
    },
    version: versionOf,
    forget(ids) {
      for (const id of ids) {
        versions.delete(id);
        newest.delete(id);
        confirming.delete(id);
      }
    },
    confirm(id) {
      if (inFlight.has(id) || waiting.has(id)) confirming.add(id);
      else startConfirm(id);
    },
    save(id, tokens, urgent = false) {
      const n = ++asked;
      newest.set(id, n);
      confirming.delete(id);
      if (!inFlight.has(id)) start(id, tokens, n, versionOf(id), urgent);
      else if (!urgent) waiting.set(id, { tokens, n });
      else {
        // The page is going away: now, with no version (see above), and
        // what waited is older than this.
        waiting.delete(id);
        start(id, tokens, n, undefined, true);
      }
    },
    flush() {
      for (const [id, next] of [...waiting]) {
        waiting.delete(id);
        start(
          id,
          next.tokens,
          next.n,
          inFlight.has(id) ? undefined : versionOf(id),
          true,
        );
      }
    },
  };
}

/**
 * The page going away (`pagehide`), in the one order that keeps its
 * writes from racing: the open editor's leave first — its urgent write
 * replaces any waiting write of its segment — then every write still
 * waiting (`flush`). The grid listens once and calls `onPageHide`; the
 * open editor hands its leave to `register`, which returns the release.
 */
export function createPageHide(queue: SaveQueue): {
  register(leaveNow: () => void): () => void;
  onPageHide(): void;
} {
  let editor: (() => void) | null = null;
  return {
    register(leaveNow) {
      editor = leaveNow;
      return () => {
        if (editor === leaveNow) editor = null;
      };
    },
    onPageHide() {
      editor?.();
      queue.flush();
    },
  };
}
