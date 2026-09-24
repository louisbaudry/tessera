/**
 * Write-back on confirm (v1-spec.md §6.2; backlog #20).
 *
 * Confirming a segment is the product's first real producer of `tuv`
 * rows from live translation work (#18's TMX import and #19's tests are
 * the only earlier writers, and #19 itself never writes one — it only
 * reads). Ties together the write-target TM (`tm-refs.ts`), context
 * capture (`core/tm/context.ts`, #17a — used here rather than
 * reinvented, since context not captured at write time is
 * unrecoverable), and the upsert/history rules `db/tm/write.ts` just
 * built, as one transaction spanning both the project and the attached
 * TM: a failure anywhere leaves the segment and the TM exactly as they
 * were. That atomicity is what v1-spec.md §6.2's "undo ... rolls back
 * in the same transaction" actually describes — not a separate undo
 * feature (an interactive unconfirm is editor work, out of scope here).
 */

import {
  confirmedTargetContext,
  sourceDocumentContext,
  toTmTokens,
  type AuditActor,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';
import { qualifySchema } from '../schema-alias.js';
import { writeBack, type WriteBackResult } from '../tm/write.js';
import { getProject } from './project.js';
import { getSegment, listSegments, setSegmentTarget } from './segments.js';
import { attachTms, listTmRefs, tmAlias } from './tm-refs.js';

export class ConfirmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfirmError';
  }
}

export interface ConfirmSegmentOptions {
  /**
   * Who confirmed it — required (audit-spec.md decision 3). Its label is
   * what the `.ctm` records as `updated_by`/`changed_by`, since a TM is
   * portable and an installation-local id would mean nothing there.
   */
  readonly actor: AuditActor;
}

export interface ConfirmSegmentResult {
  readonly tuId: number;
  readonly sourceHistorized: boolean;
  readonly targetHistorized: boolean;
}

/**
 * Confirms a segment and upserts it into the write-target TM, as one
 * transaction. Refuses a segment with no target to confirm, a locked
 * one, or a project with no enabled write-target TM configured.
 */
export function confirmSegment(
  db: Database.Database,
  segmentId: number,
  options: ConfirmSegmentOptions,
): ConfirmSegmentResult {
  const project = getProject(db);
  if (!project) {
    throw new ConfirmError('project has no identity row');
  }

  const segment = getSegment(db, segmentId);
  if (!segment) {
    throw new ConfirmError(`no segment with id ${segmentId}`);
  }
  if (!segment.targetTokens) {
    throw new ConfirmError(`segment ${segmentId} has no target to confirm`);
  }
  if (segment.locked || segment.status === 'locked') {
    throw new ConfirmError(`segment ${segmentId} is locked`);
  }

  const writeTarget = listTmRefs(db).find((r) => r.isWriteTarget && r.enabled);
  if (!writeTarget) {
    throw new ConfirmError('no enabled write-target TM configured for this project');
  }
  // ATTACHing must happen before the transaction below starts — SQLite
  // refuses ATTACH/DETACH once one is open.
  attachTms(db, [writeTarget]);
  const schema = tmAlias(writeTarget.id);

  const siblings = listSegments(db, segment.fileId);
  const sourceContext = sourceDocumentContext(siblings).get(segment.id) ?? {
    prevHash: null,
    nextHash: null,
  };
  const targetContext = confirmedTargetContext(siblings, segment.id).get(segment.id) ?? {
    prevHash: null,
    nextHash: null,
  };

  const run = db.transaction((): ConfirmSegmentResult => {
    const result: WriteBackResult = writeBack(
      db,
      {
        source: {
          lang: project.srcLang,
          tokens: toTmTokens(segment.sourceTokens, segment.formatTable),
          prevHash: sourceContext.prevHash,
          nextHash: sourceContext.nextHash,
          updatedBy: options.actor.label,
        },
        target: {
          lang: project.tgtLang,
          tokens: toTmTokens(segment.targetTokens!, segment.formatTable),
          prevHash: targetContext.prevHash,
          nextHash: targetContext.nextHash,
          updatedBy: options.actor.label,
        },
      },
      { schema },
    );

    setSegmentTarget(db, segment.id, {
      targetTokens: segment.targetTokens,
      status: 'confirmed',
      origin: segment.origin,
      actor: options.actor,
    });
    const { uuid } = db
      .prepare(`SELECT uuid FROM ${qualifySchema(schema)}tu WHERE id = ?`)
      .get(result.tuId) as { uuid: string };
    appendAuditEvent(db, {
      actor: options.actor,
      action: 'segment.confirmed',
      subjectType: 'segment',
      subjectId: String(segment.id),
      detail: { tm_write: { tu_uuid: uuid, rev: result.target.rev } },
    });

    return {
      tuId: result.tuId,
      sourceHistorized: result.source.historized,
      targetHistorized: result.target.historized,
    };
  });
  return run();
}
