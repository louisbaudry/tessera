/**
 * Accepting a draft (backlog #138; `planning/translation-engine-spec.md` D35,
 * `audit-spec.md` §4): the one write that turns a suggestion into a target.
 *
 * Everything about what accepting *means* is decided here, as `editSegmentTarget`
 * does for a typed target, so the route only parses and calls:
 *
 * - **The accepting person is the actor**; the engine is the `origin`
 *   (`mt_draft`), never an actor, and the suggestion's provenance rides in the
 *   `segment.target_set` event.
 * - **The status is `draft`**, never `translated` or `confirmed`: a person
 *   confirms it, as with a placed fuzzy match (§4).
 * - **Only an empty segment takes one.** A segment that already holds a visible
 *   target is a conflict, not an overwrite: the translator's text is not the
 *   engine's to replace, whatever order the requests arrived in.
 * - **A stale write is refused**, as for any edit (`baseUpdatedAt`), and a
 *   suggestion made for an earlier source is no suggestion (`getDraftSuggestion`).
 * - **The suggestion is consumed** in the same transaction, and QA reruns.
 */

import {
  isBlankTarget,
  MT_DRAFT_ORIGIN,
  validateTagStructure,
  withoutHiddenTags,
  type AuditActor,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { deleteDraftSuggestion, getDraftSuggestion } from './draft-suggestions.js';
import { TargetConflictError, type EditTargetResult } from './edit-target.js';
import { rerunQaAfterEdit } from './qa-issues.js';
import { getSegment, SegmentRepoError, setSegmentTarget } from './segments.js';

/** The segment has no current suggestion: none was made, it was used, or its source changed. */
export class NoSuggestionError extends Error {
  constructor(segmentId: number) {
    super(`segment ${segmentId} has no suggestion`);
    this.name = 'NoSuggestionError';
  }
}

export interface AcceptSuggestionOptions {
  /** The person accepting: required, never defaulted (audit-spec.md decision 3). */
  readonly actor: AuditActor;
  /** The segment's `updatedAt` as the editor last saw it. */
  readonly baseUpdatedAt?: string;
}

/**
 * Writes a segment's suggestion as its target and consumes it.
 *
 * @throws {SegmentRepoError} for a missing or locked segment.
 * @throws {TargetConflictError} for a stale version, or a segment that already has a target.
 * @throws {NoSuggestionError} when there is no current suggestion to accept.
 */
export function acceptDraftSuggestion(
  db: Database.Database,
  segmentId: number,
  options: AcceptSuggestionOptions,
): EditTargetResult {
  return db.transaction((): EditTargetResult => {
    const segment = getSegment(db, segmentId);
    if (!segment) throw new SegmentRepoError(`no segment with id ${segmentId}`);
    if (segment.locked || segment.status === 'locked') {
      throw new SegmentRepoError(`segment ${segmentId} is locked`);
    }
    if (
      options.baseUpdatedAt !== undefined &&
      options.baseUpdatedAt !== segment.updatedAt
    ) {
      throw new TargetConflictError(segment);
    }
    if (
      segment.targetTokens &&
      !isBlankTarget(segment.targetTokens, segment.formatTable)
    ) {
      throw new TargetConflictError(segment);
    }
    const suggestion = getDraftSuggestion(db, segmentId);
    if (!suggestion) throw new NoSuggestionError(segmentId);

    // Checked when it was drafted; checked again, since this is what export renders.
    const visible = withoutHiddenTags(suggestion.targetTokens, segment.formatTable);
    if (!validateTagStructure(visible).ok) {
      throw new NoSuggestionError(segmentId);
    }
    const stored = segment.targetTokens;
    setSegmentTarget(db, segmentId, {
      targetTokens: visible,
      status: 'draft',
      origin: MT_DRAFT_ORIGIN,
      actor: options.actor,
      provenance: {
        engine: suggestion.engine,
        model: suggestion.model,
        prompt_version: suggestion.promptVersion,
        input_sha256: suggestion.inputSha256,
      },
    });
    deleteDraftSuggestion(db, segmentId);
    const { rerun, issues } = rerunQaAfterEdit(db, segmentId, stored);
    return { segment: getSegment(db, segmentId)!, changed: true, rerun, issues };
  })();
}
