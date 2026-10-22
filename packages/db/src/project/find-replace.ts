/**
 * Find and replace across a project's targets (`v1-spec.md` §7.8; backlog #148b,
 * issue #170): the scan that previews a run and the apply that makes it. What a
 * pattern is and what a replacement does to one target are `core/project/
 * find-replace.ts`'s; this walks the project, and writes only through
 * `editSegmentTarget`, so a replaced segment is exactly a segment its translator
 * edited (hidden tags carried, status and origin derived, QA rerun, a stale write
 * refused).
 *
 * Both run on a worker thread under a time limit (`jobs/ops.ts`), since a regular
 * expression can take exponential time: the scan writes nothing, and the apply is one
 * transaction, so a run that is terminated leaves the project as it was.
 */

import {
  compileFind,
  findProblem,
  plainText,
  REPLACE_MAX_SEGMENTS,
  replaceInTokens,
  sameVisibleTarget,
  withoutHiddenTags,
  type AuditActor,
  type FindSpec,
  type SegmentStatus,
  type TextRange,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';
import { editSegmentTarget } from './edit-target.js';
import { getSegment, listAllSegments } from './segments.js';

/** The pattern or replacement cannot be run (`findProblem`'s words). */
export class FindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FindError';
  }
}

export interface ReplaceParams {
  readonly find: FindSpec;
  readonly replacement: string;
  /** One file only; omit for the whole project. */
  readonly fileId?: number;
}

/** One segment a run would change, as the preview shows it. */
export interface ReplaceProposal {
  readonly segmentId: number;
  readonly fileId: number;
  readonly ord: number;
  /** The segment's version when scanned: an apply names it, and a changed one is skipped. */
  readonly updatedAt: string;
  readonly status: SegmentStatus;
  /** The visible target's text before (tags take no room) and after. */
  readonly before: string;
  readonly after: string;
  /** Where the matches sit in `before`. */
  readonly ranges: readonly TextRange[];
  readonly count: number;
}

export interface ReplaceScan {
  readonly proposals: ReplaceProposal[];
  /** Segments with a target that were searched. */
  readonly scanned: number;
  /** Segments with a target that were left alone because they are locked. */
  readonly locked: number;
  /** True when more segments match than `REPLACE_MAX_SEGMENTS`: the rest wait for a second run. */
  readonly truncated: boolean;
}

export interface ScanHooks {
  readonly onProgress?: (done: number, total: number) => void;
  /** Checked between segments; true ends the scan with what it has. */
  readonly shouldStop?: () => boolean;
}

/** The pattern ready to run, or a {@link FindError} saying why it cannot be (`findProblem`'s words). */
function compiled(find: FindSpec, replacement: string) {
  const problem = findProblem(find, replacement);
  if (problem !== null) throw new FindError(problem);
  const found = compileFind(find);
  if ('error' in found) throw new FindError(found.error);
  return found;
}

/**
 * The segments a run would change, with their text before and after. Reads only;
 * a segment with no target, a locked one and one the pattern does not match are not
 * proposals. Throws {@link FindError} for a pattern that cannot run.
 */
export function scanReplace(
  db: Database.Database,
  params: ReplaceParams,
  hooks: ScanHooks = {},
): ReplaceScan & { readonly complete: boolean } {
  const find = compiled(params.find, params.replacement);
  const segments = listAllSegments(db).filter(
    (s) =>
      s.targetTokens !== null &&
      (params.fileId === undefined || s.fileId === params.fileId),
  );
  const proposals: ReplaceProposal[] = [];
  let scanned = 0;
  let locked = 0;
  let truncated = false;
  let complete = true;
  for (const [i, segment] of segments.entries()) {
    if (hooks.shouldStop?.()) {
      complete = false;
      break;
    }
    if (i % 50 === 0) hooks.onProgress?.(i, segments.length);
    if (segment.locked || segment.status === 'locked') {
      locked++;
      continue;
    }
    scanned++;
    const done = replaceInTokens(
      segment.targetTokens!,
      segment.formatTable,
      find,
      params.replacement,
    );
    if (done.count === 0) continue;
    if (proposals.length >= REPLACE_MAX_SEGMENTS) {
      truncated = true;
      break;
    }
    proposals.push({
      segmentId: segment.id,
      fileId: segment.fileId,
      ord: segment.ord,
      updatedAt: segment.updatedAt,
      status: segment.status,
      before: plainText(withoutHiddenTags(segment.targetTokens!, segment.formatTable)),
      after: plainText(done.tokens),
      ranges: done.ranges,
      count: done.count,
    });
  }
  return { proposals, scanned, locked, truncated, complete };
}

/** A segment the owner kept in the preview: which, and the version they saw. */
export interface ReplaceChoice {
  readonly segmentId: number;
  readonly updatedAt: string;
}

export interface ApplyReplaceParams extends ReplaceParams {
  readonly chosen: readonly ReplaceChoice[];
  /** Who ran it: required, as every audited write (audit-spec.md decision 3). */
  readonly actor: AuditActor;
}

export interface ApplyReplaceResult {
  /** Segments written. */
  readonly segments: number;
  /** Matches replaced in them. */
  readonly matches: number;
  /** Skipped: changed since the preview, so what was seen is not what is there. */
  readonly stale: number;
  /** Skipped: locked since the preview. */
  readonly locked: number;
  /** Skipped: the replacement left the visible target as it was, or nothing matched now. */
  readonly unchanged: number;
  /** The `project.replaced` event that groups the writes, or null when there were none. */
  readonly batchId: number | null;
}

/**
 * Makes the run the owner kept, as one transaction: each chosen segment whose version
 * is still the one previewed gets its replaced target through `editSegmentTarget`
 * (so a confirmed segment becomes `translated`, to be confirmed again), under one
 * `project.replaced` batch event that carries the counts and never the pattern or
 * the replacement. A stale or locked segment is skipped and counted, not an error;
 * a run that writes nothing logs nothing. More than `REPLACE_MAX_SEGMENTS` is a
 * {@link FindError}. Throws it too for a pattern that cannot run.
 */
export function applyReplace(
  db: Database.Database,
  params: ApplyReplaceParams,
): ApplyReplaceResult {
  const find = compiled(params.find, params.replacement);
  const chosen = [...new Map(params.chosen.map((c) => [c.segmentId, c])).values()];
  if (chosen.length > REPLACE_MAX_SEGMENTS) {
    throw new FindError(`Replace in at most ${REPLACE_MAX_SEGMENTS} segments at a time.`);
  }
  return db.transaction((): ApplyReplaceResult => {
    let stale = 0;
    let locked = 0;
    let unchanged = 0;
    let matches = 0;
    const writes: Array<{
      id: number;
      tokens: ReturnType<typeof replaceInTokens>['tokens'];
      updatedAt: string;
    }> = [];
    for (const choice of chosen) {
      const segment = getSegment(db, choice.segmentId);
      if (
        !segment ||
        segment.targetTokens === null ||
        segment.updatedAt !== choice.updatedAt
      ) {
        stale++;
        continue;
      }
      if (segment.locked || segment.status === 'locked') {
        locked++;
        continue;
      }
      const done = replaceInTokens(
        segment.targetTokens,
        segment.formatTable,
        find,
        params.replacement,
      );
      if (
        done.count === 0 ||
        sameVisibleTarget(done.tokens, segment.targetTokens, segment.formatTable)
      ) {
        unchanged++;
        continue;
      }
      matches += done.count;
      writes.push({ id: segment.id, tokens: done.tokens, updatedAt: segment.updatedAt });
    }
    if (writes.length === 0) {
      return { segments: 0, matches: 0, stale, locked, unchanged, batchId: null };
    }
    const batch = appendAuditEvent(db, {
      actor: params.actor,
      action: 'project.replaced',
      subjectType: 'project',
      subjectId: null,
      detail: {
        regex: params.find.regex,
        case_sensitive: params.find.caseSensitive,
        segments: writes.length,
        matches,
        stale,
        locked,
      },
    });
    for (const write of writes) {
      editSegmentTarget(db, write.id, {
        tokens: write.tokens,
        actor: params.actor,
        baseUpdatedAt: write.updatedAt,
        batchId: batch.id,
      });
    }
    return {
      segments: writes.length,
      matches,
      stale,
      locked,
      unchanged,
      batchId: batch.id,
    };
  })();
}
