/**
 * Keystroke drafts (backlog #31, v1-spec.md §7.2): what the open editor
 * holds, a moment after each keystroke, kept in this browser so a crash —
 * the tab's, the browser's, the network's — costs seconds of typing, not
 * the segment. They never reach the server: the audited write stays at
 * segment boundaries (audit-spec §2.2), and a draft is only ever turned
 * into that write, once, by `recoverDrafts` on the next load.
 *
 * A draft is the visible target plus the version of the segment the next
 * write of it would go over (`SaveQueue.version`), and the source's hash,
 * so a draft is never put on a segment that is no longer the one it was
 * typed into (a merge, a split, a project deleted and made again).
 *
 * Storage is `localStorage`, scoped by account and project, so one
 * person's drafts are never offered to another signed in on the same
 * browser. It can be absent or throw, as for the session token
 * (`session.ts`); then a draft lasts as long as the page, which is what
 * the editor had before. Pure of React and the DOM — the storage is
 * passed in — so it is tested in node (`drafts.test.ts`).
 */
import type { Segment, Token } from '@cat-tool/core';
import { isBlankTarget, sameVisibleTarget } from '@cat-tool/core/model';

export interface Draft {
  /** The segment version the draft's write would go over. */
  readonly base: string | undefined;
  /** The source the draft was typed against (`Segment.sourceHash`). */
  readonly sourceHash: string;
  /** The visible target, as the editor sends it. */
  readonly tokens: readonly Token[];
  /** When it was written, ms since the epoch: old drafts are pruned. */
  readonly savedAt: number;
}

/** The part of `Storage` drafts use. */
export type DraftStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'
>;

/**
 * How long after the last keystroke the open editor's draft is kept:
 * at most this much typing is what a crash can cost.
 */
export const DRAFT_DELAY_MS = 500;

/** A draft older than this is dropped unread: its page is long gone. */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const PREFIX = 'cat-tool.draft.';

export interface Drafts {
  write(segmentId: number, draft: Draft): void;
  read(segmentId: number): Draft | undefined;
  clear(segmentId: number): void;
  /** Every draft in this scope, by segment id; expired ones are removed. */
  all(now?: number): Map<number, Draft>;
}

export function createDrafts(
  storage: DraftStorage | null,
  scope: { readonly account: number; readonly project: string },
): Drafts {
  const prefix = `${PREFIX}${scope.account}.${encodeURIComponent(scope.project)}.`;
  const keyOf = (segmentId: number) => `${prefix}${segmentId}`;
  // Every call may throw (blocked storage, a full quota): a draft that
  // cannot be kept is the editor without autosave, never an error.
  const attempt = <T>(fn: () => T, otherwise: T): T => {
    if (!storage) return otherwise;
    try {
      return fn();
    } catch {
      return otherwise;
    }
  };
  const parse = (raw: string | null): Draft | undefined => {
    if (raw === null) return undefined;
    try {
      const d = JSON.parse(raw) as Partial<Draft>;
      return typeof d.sourceHash === 'string' &&
        Array.isArray(d.tokens) &&
        typeof d.savedAt === 'number'
        ? (d as Draft)
        : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    write(segmentId, draft) {
      attempt(() => storage!.setItem(keyOf(segmentId), JSON.stringify(draft)), undefined);
    },
    read(segmentId) {
      return attempt(() => parse(storage!.getItem(keyOf(segmentId))), undefined);
    },
    clear(segmentId) {
      attempt(() => storage!.removeItem(keyOf(segmentId)), undefined);
    },
    all(now = Date.now()) {
      const found = new Map<number, Draft>();
      attempt(() => {
        const keys: string[] = [];
        for (let i = 0; i < storage!.length; i++) {
          const key = storage!.key(i);
          if (key?.startsWith(prefix)) keys.push(key);
        }
        for (const key of keys) {
          const id = Number(key.slice(prefix.length));
          const draft = parse(storage!.getItem(key));
          if (!Number.isInteger(id) || !draft || now - draft.savedAt > DRAFT_MAX_AGE_MS) {
            storage!.removeItem(key);
          } else {
            found.set(id, draft);
          }
        }
      }, undefined);
      return found;
    },
  };
}

/** This browser's `localStorage`, or null where even reaching it throws. */
export function browserStorage(): DraftStorage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export interface Recovery {
  /** Still over the version stored: send as the leave-write the page never made. */
  readonly resend: ReadonlyArray<{
    readonly id: number;
    readonly tokens: readonly Token[];
  }>;
  /** The segment changed since: not applied, and the translator told. */
  readonly conflicts: ReadonlyArray<{
    readonly id: number;
    readonly tokens: readonly Token[];
  }>;
  /** Nothing to do — it landed, or it is for another segment now: forget it. */
  readonly drop: readonly number[];
}

/**
 * What to do with the drafts left by a page that went away (`all`), for
 * one file's segments as the server has them now. A draft for a segment
 * of another file is not this file's to judge, and is left alone.
 *
 * - Another source than the draft's → dropped: not the segment it was typed into.
 * - The same visible target as stored → dropped: its write landed (the
 *   `pagehide` write, whose answer nobody was left to hear), or it never
 *   changed anything.
 * - Over the version stored → resent, through the save queue like any
 *   leave: the server derives status and origin and audits it.
 * - Over an older version → a conflict: another tab or device saved the
 *   segment since, and its write is never silently replaced (the same
 *   rule as the server's 409, §7.2).
 */
export function recoverDrafts(
  segments: readonly Segment[],
  drafts: ReadonlyMap<number, Draft>,
): Recovery {
  const resend: Array<{ id: number; tokens: readonly Token[] }> = [];
  const conflicts: Array<{ id: number; tokens: readonly Token[] }> = [];
  const drop: number[] = [];
  for (const segment of segments) {
    const draft = drafts.get(segment.id);
    if (!draft) continue;
    if (draft.sourceHash !== segment.sourceHash) drop.push(segment.id);
    else if (sameTarget(draft.tokens, segment)) drop.push(segment.id);
    else if (draft.base === segment.updatedAt) {
      resend.push({ id: segment.id, tokens: draft.tokens });
    } else conflicts.push({ id: segment.id, tokens: draft.tokens });
  }
  return { resend, conflicts, drop };
}

/** Whether a draft says what the segment stores, to the translator. */
export function sameTarget(tokens: readonly Token[], segment: Segment): boolean {
  const stored = segment.targetTokens;
  if (isBlankTarget(tokens, segment.formatTable)) {
    return isBlankTarget(stored, segment.formatTable);
  }
  return stored !== null && sameVisibleTarget(tokens, stored, segment.formatTable);
}

/** A draft's words, for telling the translator what was not restored. */
export function draftText(tokens: readonly Token[]): string {
  return tokens
    .map((t) => (t.t === 'text' ? t.v : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}
