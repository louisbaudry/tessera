/**
 * The translator's own write of a target (v1-spec.md §7.2; backlog #29):
 * what the editor sends when it leaves a segment. Everything about what
 * that write *means* is decided here, not by the client or the route —
 * the CLI rule (§2.4) that the server then keeps:
 *
 * - **The client sends what the translator placed**: text and visible
 *   tags. Hidden tags are carried by `setSegmentTarget`, whatever the
 *   tokens held.
 * - **An edit that changes nothing visible is no edit.** Same visible
 *   target (`sameVisibleTarget`) — whatever its hidden tags, however its
 *   text is split — and nothing is written: a TM match clicked through
 *   keeps its origin, a confirmed segment stays confirmed.
 * - **Status and origin are derived.** A target with anything visible in
 *   it is the translator's: `translated`, no machine origin (the audit
 *   log's previous event keeps what it was). One with nothing visible is
 *   an untranslated segment again: `null`, `new` — never an empty
 *   translation, which export would deliver as a missing sentence.
 *   Editing a confirmed segment makes it `translated`, to be confirmed
 *   again before the TM hears of it.
 * - **A stale write is refused.** `baseUpdatedAt` is the segment as the
 *   editor last saw it; a write over a newer one — another tab, another
 *   session — is a conflict, not a silent overwrite.
 * - **A structure export would refuse is refused now**, not at delivery.
 * - **QA reruns in the same transaction**, for the segment and every
 *   segment sharing its source (`consistency.target_differs`), so the
 *   grid's marks follow the edit instead of going stale until someone
 *   runs `cat-tool qa`.
 */
import {
  sameVisibleTarget,
  validateTagStructure,
  withoutHiddenTags,
  type AuditActor,
  type QaIssue,
  type Segment,
  type Token,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { runQaRules } from './qa-issues.js';
import { getSegment, SegmentRepoError, setSegmentTarget } from './segments.js';

/** The segment changed since the editor loaded it; `current` is how it stands. */
export class TargetConflictError extends Error {
  constructor(readonly current: Segment) {
    super(`segment ${current.id} was changed elsewhere since it was opened`);
    this.name = 'TargetConflictError';
  }
}

/** The visible target is not a structure export could render. */
export class TargetStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetStructureError';
  }
}

export interface EditTargetOptions {
  /** What the translator placed. Hidden tags in it are ignored. */
  readonly tokens: readonly Token[];
  /** Who made the edit — required, never defaulted (audit-spec.md decision 3). */
  readonly actor: AuditActor;
  /** The segment's `updatedAt` as the editor last saw it. */
  readonly baseUpdatedAt?: string;
}

export interface EditTargetResult {
  readonly segment: Segment;
  readonly changed: boolean;
  /** Every segment QA reran: this one and its same-source siblings. */
  readonly rerun: readonly number[];
  /** Their QA issues now, dismissed ones included. */
  readonly issues: readonly QaIssue[];
}

export function editSegmentTarget(
  db: Database.Database,
  id: number,
  options: EditTargetOptions,
): EditTargetResult {
  return db.transaction((): EditTargetResult => {
    const segment = getSegment(db, id);
    if (!segment) throw new SegmentRepoError(`no segment with id ${id}`);
    if (segment.locked || segment.status === 'locked') {
      throw new SegmentRepoError(`segment ${id} is locked`);
    }
    if (
      options.baseUpdatedAt !== undefined &&
      options.baseUpdatedAt !== segment.updatedAt
    ) {
      throw new TargetConflictError(segment);
    }

    const visible = withoutHiddenTags(options.tokens, segment.formatTable);
    const structure = validateTagStructure(visible);
    if (!structure.ok) {
      const detail = structure.errors.map((e) => `${e.code} (tag ${e.id})`).join(', ');
      throw new TargetStructureError(`the target's tags do not nest: ${detail}`);
    }
    const empty = visible.every((t) => t.t === 'text' && t.v === '');
    const stored = segment.targetTokens;
    if (
      (stored === null) === empty &&
      sameVisibleTarget(visible, stored ?? [], segment.formatTable)
    ) {
      return { segment, changed: false, rerun: [], issues: [] };
    }

    setSegmentTarget(db, id, {
      targetTokens: empty ? null : visible,
      status: empty ? 'new' : 'translated',
      origin: null,
      actor: options.actor,
    });
    const siblings = db
      .prepare('SELECT id FROM segment WHERE source_hash = ? AND id != ? ORDER BY id')
      .all(segment.sourceHash, id) as Array<{ id: number }>;
    const rerun = [id, ...siblings.map((s) => s.id)];
    const issues = rerun.flatMap((sid) => runQaRules(db, sid));
    return { segment: getSegment(db, id)!, changed: true, rerun, issues };
  })();
}
