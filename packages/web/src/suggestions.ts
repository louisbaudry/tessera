/**
 * The draft suggestion strip's logic (backlog #138;
 * `planning/translation-engine-spec.md` D33, D36, D37). Pure of React and
 * `fetch`, as the save queue is, so what to ask for, in what order, and when to
 * stop are proven in node (`suggestions.test.ts`); `Grid.tsx` and
 * `TargetEditor.tsx` only render and wire.
 *
 * **The translator never waits on a draft and never learns why there is none.**
 * A segment's suggestion is asked for ahead of the cursor, one request at a time,
 * and a missing one is the normal state: the page cannot tell an engine that is
 * off from one with nothing to say (the server answers the same, D34), so it gives
 * up after a few empty answers in a row rather than ask for ever, and a request
 * that fails is never shown.
 */
import type { Segment, Token } from '@cat-tool/core';
import { isBlankTarget } from '@cat-tool/core/model';

/** How many segments past the open one are asked about. */
export const PREFETCH_AHEAD = 3;

/** Empty answers in a row after which the page stops asking until it is reloaded. */
export const GIVE_UP_AFTER = 3;

/** Whether a segment could take a draft: unlocked, new, and nothing visible in its target. */
export function wantsDraft(segment: Segment): boolean {
  return (
    !segment.locked &&
    segment.status === 'new' &&
    (segment.targetTokens === null ||
      isBlankTarget(segment.targetTokens, segment.formatTable))
  );
}

/**
 * The segments to ask about now: the open one first (the translator is looking at
 * it), then the next few after it, in the order the grid shows them. A segment is
 * left out when it cannot take a draft, already has one, or was already asked about
 * this page load, so moving the cursor back and forth asks nothing twice.
 */
export function planPrefetch(
  shown: readonly Segment[],
  activeId: number | null,
  settled: ReadonlySet<number>,
  ahead: number = PREFETCH_AHEAD,
): number[] {
  const at = activeId === null ? -1 : shown.findIndex((s) => s.id === activeId);
  if (at < 0) return [];
  const out: number[] = [];
  for (let i = at; i < shown.length && out.length < ahead + 1; i++) {
    const s = shown[i]!;
    if (wantsDraft(s) && !settled.has(s.id)) out.push(s.id);
  }
  return out;
}

export interface PrefetcherDeps {
  /** Asks the server for one segment's draft: tokens, or null for none. May reject. */
  readonly ask: (segmentId: number) => Promise<readonly Token[] | null>;
  /** A draft arrived. */
  readonly onSuggestion: (segmentId: number, tokens: readonly Token[]) => void;
  readonly giveUpAfter?: number;
}

export interface Prefetcher {
  /**
   * What to ask about next, most wanted first. Replaces what was waiting (the
   * cursor moved), never what is in flight, and skips anything already settled.
   */
  want(ids: readonly number[]): void;
  /** This segment already has a draft (loaded with the page): never ask for it. */
  have(segmentId: number): void;
  /** The ids asked about, answered or not: what `planPrefetch` leaves out. */
  readonly settled: ReadonlySet<number>;
  /** Resolves once nothing is in flight or waiting. */
  whenIdle(): Promise<void>;
}

/**
 * One request at a time, so a draft never competes with the translator's own
 * saves for the connection and the server drafts in the order the translator
 * will reach the segments. After `giveUpAfter` empty or failed answers in a row it
 * stops, and a draft arriving resets the count.
 */
export function createPrefetcher(deps: PrefetcherDeps): Prefetcher {
  const giveUpAfter = deps.giveUpAfter ?? GIVE_UP_AFTER;
  const settled = new Set<number>();
  let waiting: number[] = [];
  let running = false;
  let misses = 0;
  let idle: Array<() => void> = [];

  const wake = () => {
    if (running || waiting.length > 0) return;
    for (const resolve of idle) resolve();
    idle = [];
  };

  const run = async (): Promise<void> => {
    running = true;
    while (waiting.length > 0 && misses < giveUpAfter) {
      const id = waiting.shift()!;
      if (settled.has(id)) continue;
      settled.add(id);
      try {
        const tokens = await deps.ask(id);
        if (tokens) {
          misses = 0;
          deps.onSuggestion(id, tokens);
        } else {
          misses++;
        }
      } catch {
        // Never shown: a missing draft is the normal state of a segment.
        misses++;
      }
    }
    if (misses >= giveUpAfter) waiting = [];
    running = false;
    wake();
  };

  return {
    want(ids) {
      if (misses >= giveUpAfter) return;
      waiting = ids.filter((id) => !settled.has(id));
      if (!running && waiting.length > 0) void run();
    },
    have(segmentId) {
      settled.add(segmentId);
    },
    settled,
    whenIdle() {
      if (!running && waiting.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idle.push(resolve));
    },
  };
}
