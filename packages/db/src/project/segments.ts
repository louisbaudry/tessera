/**
 * `segment` repository (v1-spec.md §4.1; backlog #16).
 *
 * Segments are written in bulk by `insertFile`; this module is the read
 * side, plus the one write a translator (or the future matcher/write-
 * back, #19/#20) actually performs afterward — updating one segment's
 * target.
 */

import {
  carryHiddenTags,
  type AuditActor,
  type DocPart,
  type FormatEntry,
  type Origin,
  type Segment,
  type SegmentStatus,
  type Token,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';

export class SegmentRepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SegmentRepoError';
  }
}

interface SegmentRow {
  id: number;
  file_id: number;
  part: string;
  ord: number;
  para_key: string;
  para_ord: number;
  source_tokens: string;
  format_table: string;
  target_tokens: string | null;
  source_hash: string;
  status: string;
  origin: string | null;
  locked: number;
  fallback_copy: number;
  updated_at: string;
}

const fromRow = (row: SegmentRow): Segment => ({
  id: row.id,
  fileId: row.file_id,
  part: row.part as DocPart,
  ord: row.ord,
  paraKey: row.para_key,
  paraOrd: row.para_ord,
  sourceTokens: JSON.parse(row.source_tokens) as readonly Token[],
  formatTable: JSON.parse(row.format_table) as Segment['formatTable'],
  targetTokens: row.target_tokens
    ? (JSON.parse(row.target_tokens) as readonly Token[])
    : null,
  sourceHash: row.source_hash,
  status: row.status as SegmentStatus,
  origin: row.origin as Origin | null,
  locked: Boolean(row.locked),
  fallbackCopy: Boolean(row.fallback_copy),
  updatedAt: row.updated_at,
});

export function getSegment(db: Database.Database, id: number): Segment | null {
  const row = db.prepare('SELECT * FROM segment WHERE id = ?').get(id) as
    SegmentRow | undefined;
  return row ? fromRow(row) : null;
}

/** A file's segments, in document order — the order the editor presents them in. */
export function listSegments(db: Database.Database, fileId: number): Segment[] {
  const rows = db
    .prepare('SELECT * FROM segment WHERE file_id = ? ORDER BY ord')
    .all(fileId) as SegmentRow[];
  return rows.map(fromRow);
}

/** Every segment across every file in the project, in file then document order. */
/** How many segments a file has — a count, not a load of every row. */
export function countSegments(db: Database.Database, fileId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM segment WHERE file_id = ?')
    .get(fileId) as { n: number };
  return row.n;
}

export function listAllSegments(db: Database.Database): Segment[] {
  const rows = db
    .prepare('SELECT * FROM segment ORDER BY file_id, ord')
    .all() as SegmentRow[];
  return rows.map(fromRow);
}

export interface SetTargetOptions {
  readonly targetTokens: readonly Token[] | null;
  readonly status: SegmentStatus;
  readonly origin: Origin | null;
  /** Who made the change — required, never defaulted (audit-spec.md decision 3). */
  readonly actor: AuditActor;
  /** The batch-level event this write belongs to (spec §2.3), e.g. a pre-translate run. */
  readonly batchId?: number;
}

/**
 * Sets a segment's target, status, and origin together — the three
 * fields that only ever change as one fact ("this segment is now a
 * confirmed translation from this source"), never independently — and
 * records it as a `segment.target_set` event in the same transaction,
 * with the state *after* the change (audit-spec.md §2.2).
 *
 * The target is stored with its source's hidden tags carried
 * (`carryHiddenTags`, v1-spec.md §7.2), whoever wrote it: an editor
 * save, a TM match, a propagation. Hidden tags are never a writer's to
 * place, so every stored target has them where one rule puts them, and
 * none is lost on export however the target was made (backlog #29).
 *
 * A write that changes none of the three is not a change: no `UPDATE`,
 * no event, and `false` is returned. Otherwise every pre-translate
 * re-run would log a row per already-matched segment (spec §2.4).
 *
 * Refuses on a locked segment — `locked`, or the `locked` status:
 * `v1-spec.md` §6.1 forbids pre-translate from touching one, and there
 * is no reason an interactive edit should be allowed to where
 * pre-translate isn't.
 */
export function setSegmentTarget(
  db: Database.Database,
  id: number,
  options: SetTargetOptions,
): boolean {
  return db.transaction((): boolean => {
    const current = db
      .prepare(
        `SELECT target_tokens, status, origin, locked, source_tokens, format_table
         FROM segment WHERE id = ?`,
      )
      .get(id) as
      | Pick<
          SegmentRow,
          | 'target_tokens'
          | 'status'
          | 'origin'
          | 'locked'
          | 'source_tokens'
          | 'format_table'
        >
      | undefined;
    if (!current) {
      throw new SegmentRepoError(`no segment with id ${id}`);
    }
    if (current.locked || current.status === 'locked') {
      throw new SegmentRepoError(`segment ${id} is locked`);
    }
    const carried = options.targetTokens
      ? carryHiddenTags(
          options.targetTokens,
          JSON.parse(current.source_tokens) as Token[],
          JSON.parse(current.format_table) as FormatEntry[],
        )
      : null;
    const targetTokens = carried ? JSON.stringify(carried) : null;
    if (
      current.target_tokens === targetTokens &&
      current.status === options.status &&
      current.origin === options.origin
    ) {
      return false;
    }
    db.prepare(
      `UPDATE segment
       SET target_tokens = @target_tokens, status = @status, origin = @origin,
           updated_at = @updated_at
       WHERE id = @id`,
    ).run({
      id,
      target_tokens: targetTokens,
      status: options.status,
      origin: options.origin,
      updated_at: new Date().toISOString(),
    });
    appendAuditEvent(db, {
      actor: options.actor,
      action: 'segment.target_set',
      subjectType: 'segment',
      subjectId: String(id),
      batchId: options.batchId ?? null,
      detail: {
        status: options.status,
        origin: options.origin,
        target_tokens: carried,
      },
    });
    return true;
  })();
}
