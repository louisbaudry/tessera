/**
 * Merge and split of segments, applied to a project file (v1-spec.md
 * §7.4; backlog #30a). `core/segment/edit.ts` is the pure policy
 * (`splitEditableSegment`, `mergeEditableSegments`); this is what it never
 * had — the rows, the ordering the fold reads, the hashes, the audit
 * events and QA, in one transaction, so a route stays one call (the CLI
 * rule, §2.4).
 *
 * - **A split keeps the row's id on the first half** (its audit history,
 *   its QA rows) and inserts the second after it; **a merge keeps the
 *   first row's id** and deletes the second's, with its QA issues. Later
 *   segments of the paragraph move by one in `para_ord` — export folds a
 *   paragraph in that order — and of the file in `ord`.
 * - **The target is the translator's part only** — text and visible tags —
 *   and its hidden tags are carried again from the new source
 *   (`carryHiddenTags`, backlog #29), as for any write.
 * - **Nothing stays confirmed, and no origin survives**: the result is a
 *   draft, or `new` with no target; a manual edit is not a TM hit.
 * - **A stale write is refused**, as an edit's is (`baseUpdatedAt`).
 */
import {
  carryHiddenTags,
  isBlankTarget,
  mergeEditableSegments,
  normalizeTokens,
  splitEditableSegment,
  withoutHiddenTags,
  type AuditActor,
  type EditableSegment,
  type QaIssue,
  type Segment,
  type SegmentStateDetail,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';
import { TargetConflictError } from './edit-target.js';
import { rerunQaAfterRestructure } from './qa-issues.js';
import { getSegment, SegmentRepoError } from './segments.js';

export interface RestructureResult {
  /** The segments now standing in place of the ones asked about, in document order. */
  readonly segments: readonly Segment[];
  /** Segment ids that no longer exist (the second of a merge). */
  readonly removed: readonly number[];
  /** Every segment QA reran, the ones above first. */
  readonly rerun: readonly number[];
  /** Their QA issues now, dismissed ones included. */
  readonly issues: readonly QaIssue[];
}

export interface SplitOptions {
  /** Plain-text offset into the segment's source at which to cut. */
  readonly offset: number;
  /** Who split it — required (audit-spec.md decision 3). */
  readonly actor: AuditActor;
  /** The segment's `updatedAt` as the editor last saw it. */
  readonly baseUpdatedAt?: string;
}

export interface MergeOptions {
  /** Who merged them — required. */
  readonly actor: AuditActor;
  /** The first segment's `updatedAt` as the editor last saw it. */
  readonly baseUpdatedAt?: string;
  /** The next segment's, likewise. */
  readonly nextBaseUpdatedAt?: string;
}

/** The segment as the editing layer sees it: the translator's part of the target. */
function editable(segment: Segment): EditableSegment {
  const visible = segment.targetTokens
    ? withoutHiddenTags(segment.targetTokens, segment.formatTable)
    : null;
  return {
    source: { tokens: segment.sourceTokens, formats: segment.formatTable },
    target:
      visible && !isBlankTarget(visible, segment.formatTable)
        ? { tokens: visible, formats: segment.formatTable }
        : null,
    status: segment.status,
    locked: segment.locked,
  };
}

function assertUnlocked(segment: Segment): void {
  if (segment.locked || segment.status === 'locked') {
    throw new SegmentRepoError(`segment ${segment.id} is locked`);
  }
}

/**
 * Moves every segment of a file after `after` by `by` places, keeping
 * `UNIQUE (file_id, ord)` whole: SQLite checks it row by row, so the
 * rows go through negative values rather than over one another.
 */
function shiftOrd(
  db: Database.Database,
  fileId: number,
  after: number,
  by: number,
): void {
  db.prepare(
    'UPDATE segment SET ord = -(ord + @by) WHERE file_id = @fileId AND ord > @after',
  ).run({ fileId, after, by });
  db.prepare('UPDATE segment SET ord = -ord WHERE file_id = @fileId AND ord < 0').run({
    fileId,
  });
}

/** Moves the later segments of one paragraph in `para_ord`. */
function shiftParaOrd(
  db: Database.Database,
  segment: Segment,
  after: number,
  by: number,
): void {
  db.prepare(
    `UPDATE segment SET para_ord = para_ord + @by
     WHERE file_id = @fileId AND part = @part AND para_key = @paraKey
       AND para_ord > @after`,
  ).run({
    by,
    fileId: segment.fileId,
    part: segment.part,
    paraKey: segment.paraKey,
    after,
  });
}

/** What a stored half or merge looks like: source, and the carried target. */
function stored(part: EditableSegment) {
  const target = part.target
    ? carryHiddenTags(part.target.tokens, part.source.tokens, part.source.formats)
    : null;
  return {
    sourceTokens: JSON.stringify(part.source.tokens),
    formatTable: JSON.stringify(part.source.formats),
    sourceHash: normalizeTokens(part.source.tokens).hash,
    targetTokens: target ? JSON.stringify(target) : null,
    target,
    status: part.target ? part.status : ('new' as const),
  };
}

const stateOf = (s: ReturnType<typeof stored>): SegmentStateDetail => ({
  status: s.status,
  origin: null,
  target_tokens: s.target,
});

/**
 * Splits a segment at a plain-text offset of its source. The whole
 * target stays on the first half, as a draft; the second is a new,
 * untranslated segment (`splitEditableSegment`).
 */
export function splitSegmentAt(
  db: Database.Database,
  id: number,
  options: SplitOptions,
): RestructureResult {
  return db.transaction((): RestructureResult => {
    const segment = getSegment(db, id);
    if (!segment) throw new SegmentRepoError(`no segment with id ${id}`);
    assertUnlocked(segment);
    if (
      options.baseUpdatedAt !== undefined &&
      options.baseUpdatedAt !== segment.updatedAt
    ) {
      throw new TargetConflictError(segment);
    }
    // Throws `SegmentEditError` for an offset outside the source's interior.
    const [firstPart, secondPart] = splitEditableSegment(
      editable(segment),
      options.offset,
    );
    const first = stored(firstPart);
    const second = stored(secondPart);
    const now = new Date().toISOString();

    shiftOrd(db, segment.fileId, segment.ord, 1);
    shiftParaOrd(db, segment, segment.paraOrd, 1);
    db.prepare(
      `UPDATE segment
       SET source_tokens = @source_tokens, format_table = @format_table,
           source_hash = @source_hash, target_tokens = @target_tokens,
           status = @status, origin = NULL, updated_at = @updated_at
       WHERE id = @id`,
    ).run({
      id,
      source_tokens: first.sourceTokens,
      format_table: first.formatTable,
      source_hash: first.sourceHash,
      target_tokens: first.targetTokens,
      status: first.status,
      updated_at: now,
    });
    const newId = Number(
      db
        .prepare(
          `INSERT INTO segment
             (file_id, part, ord, para_key, para_ord, source_tokens, format_table,
              source_hash, status, locked, fallback_copy, updated_at)
           VALUES
             (@file_id, @part, @ord, @para_key, @para_ord, @source_tokens, @format_table,
              @source_hash, 'new', 0, @fallback_copy, @updated_at)`,
        )
        .run({
          file_id: segment.fileId,
          part: segment.part,
          ord: segment.ord + 1,
          para_key: segment.paraKey,
          para_ord: segment.paraOrd + 1,
          source_tokens: second.sourceTokens,
          format_table: second.formatTable,
          source_hash: second.sourceHash,
          // Both halves are of one paragraph, so of one copy of it.
          fallback_copy: segment.fallbackCopy ? 1 : 0,
          updated_at: now,
        }).lastInsertRowid,
    );
    appendAuditEvent(db, {
      actor: options.actor,
      action: 'segment.split',
      subjectType: 'segment',
      subjectId: String(id),
      detail: {
        new_segment_id: newId,
        offset: options.offset,
        first: stateOf(first),
        second: stateOf(second),
      },
    });
    const { rerun, issues } = rerunQaAfterRestructure(db, [id, newId], {
      sourceHashes: [segment.sourceHash],
      targets: [segment.targetTokens],
    });
    return {
      segments: [getSegment(db, id)!, getSegment(db, newId)!],
      removed: [],
      rerun,
      issues,
    };
  })();
}

/**
 * Merges a segment with the next one of its paragraph. Refuses the last
 * segment of a paragraph — a merge never crosses one (spec §7.4).
 */
export function mergeSegmentWithNext(
  db: Database.Database,
  id: number,
  options: MergeOptions,
): RestructureResult {
  return db.transaction((): RestructureResult => {
    const segment = getSegment(db, id);
    if (!segment) throw new SegmentRepoError(`no segment with id ${id}`);
    const nextRow = db
      .prepare(
        `SELECT id FROM segment
         WHERE file_id = ? AND part = ? AND para_key = ? AND para_ord = ?`,
      )
      .get(segment.fileId, segment.part, segment.paraKey, segment.paraOrd + 1) as
      { id: number } | undefined;
    const next = nextRow ? getSegment(db, nextRow.id) : null;
    if (!next) {
      throw new SegmentRepoError(
        `segment ${id} is the last of its paragraph: there is nothing to merge it with`,
      );
    }
    assertUnlocked(segment);
    assertUnlocked(next);
    if (
      options.baseUpdatedAt !== undefined &&
      options.baseUpdatedAt !== segment.updatedAt
    ) {
      throw new TargetConflictError(segment);
    }
    if (
      options.nextBaseUpdatedAt !== undefined &&
      options.nextBaseUpdatedAt !== next.updatedAt
    ) {
      throw new TargetConflictError(next);
    }

    const merged = stored(mergeEditableSegments(editable(segment), editable(next)));
    const now = new Date().toISOString();

    db.prepare('DELETE FROM qa_issue WHERE segment_id = ?').run(next.id);
    db.prepare('DELETE FROM segment WHERE id = ?').run(next.id);
    shiftOrd(db, segment.fileId, next.ord, -1);
    shiftParaOrd(db, segment, next.paraOrd, -1);
    db.prepare(
      `UPDATE segment
       SET source_tokens = @source_tokens, format_table = @format_table,
           source_hash = @source_hash, target_tokens = @target_tokens,
           status = @status, origin = NULL, updated_at = @updated_at
       WHERE id = @id`,
    ).run({
      id,
      source_tokens: merged.sourceTokens,
      format_table: merged.formatTable,
      source_hash: merged.sourceHash,
      target_tokens: merged.targetTokens,
      status: merged.status,
      updated_at: now,
    });
    appendAuditEvent(db, {
      actor: options.actor,
      action: 'segment.merged',
      subjectType: 'segment',
      subjectId: String(id),
      detail: { removed_segment_id: next.id, state: stateOf(merged) },
    });
    const { rerun, issues } = rerunQaAfterRestructure(db, [id], {
      sourceHashes: [segment.sourceHash, next.sourceHash],
      targets: [segment.targetTokens, next.targetTokens],
    });
    return { segments: [getSegment(db, id)!], removed: [next.id], rerun, issues };
  })();
}
