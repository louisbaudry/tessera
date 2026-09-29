/**
 * The translator's confirm (v1-spec.md §7.3; backlog #30): what the
 * editor's Ctrl+Enter sends. `confirmSegment` is the write-back and the
 * status change; this is what an editor adds around it, kept in `db` so
 * the route stays one repository call (the CLI rule, §2.4):
 *
 * - **A stale confirm is refused**, as a stale edit is (`baseUpdatedAt`):
 *   confirming is approving the text the translator saw.
 * - **Confirming a confirmed segment is no confirm.** Nothing is written
 *   — no second audit event, no second memory revision — and the caller
 *   just advances.
 * - **QA reruns** for the segment (`rerunQaAfterEdit`): `seg.empty` and
 *   its kin read the status, which the confirm changed (§6.4).
 */
import type { AuditActor, QaIssue, Segment } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { confirmSegment } from './confirm.js';
import { TargetConflictError } from './edit-target.js';
import { rerunQaAfterEdit } from './qa-issues.js';
import { getSegment, SegmentRepoError } from './segments.js';

export interface ConfirmEditedOptions {
  /** Who confirmed it — required (audit-spec.md decision 3). */
  readonly actor: AuditActor;
  /** The segment's `updatedAt` as the editor last saw it. */
  readonly baseUpdatedAt?: string;
}

export interface ConfirmEditedResult {
  readonly segment: Segment;
  /** False when the segment was already confirmed and nothing was written. */
  readonly changed: boolean;
  /** Every segment QA reran, this one first. */
  readonly rerun: readonly number[];
  /** Their QA issues now, dismissed ones included. */
  readonly issues: readonly QaIssue[];
}

export function confirmEditedSegment(
  db: Database.Database,
  segmentId: number,
  options: ConfirmEditedOptions,
): ConfirmEditedResult {
  const segment = getSegment(db, segmentId);
  if (!segment) throw new SegmentRepoError(`no segment with id ${segmentId}`);
  if (
    options.baseUpdatedAt !== undefined &&
    options.baseUpdatedAt !== segment.updatedAt
  ) {
    throw new TargetConflictError(segment);
  }
  if (segment.status === 'confirmed') {
    return { segment, changed: false, rerun: [], issues: [] };
  }
  // Refuses a blank target, a locked segment, and a project with no
  // write-target memory (`ConfirmError`), before writing anything.
  confirmSegment(db, segmentId, { actor: options.actor });
  const { rerun, issues } = rerunQaAfterEdit(db, segmentId, segment.targetTokens);
  return { segment: getSegment(db, segmentId)!, changed: true, rerun, issues };
}
