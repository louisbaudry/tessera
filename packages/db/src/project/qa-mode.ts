/**
 * Live or deferred QA for a project (issue #361, `planning/v1-spec.md` §7.10).
 *
 * Live is the default and the only mode a project had before: every edit and confirm reruns
 * QA for the segments it can move (`rerunQaAfterEdit`). Deferred skips that rerun and counts
 * the edit instead, so a very large project pays for QA once, in a sweep (`sweepQa`), not
 * on every save. Findings are then out of date until a sweep, and **every gate that reads
 * them must not read them stale**: `assertQaCurrent` is what a gate calls first, and it
 * refuses rather than sweep, because a sweep is a job (6 s at 100,000 segments), never a
 * request. A blocking issue therefore cannot ship because QA was deferred.
 *
 * Absence-based, like `qa_rule_setting`: no row is live. A change is one
 * `project.setting_changed` in the project's log, in the transaction that writes it.
 */

import type { AuditActor } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';

/** The `key` of the `project.setting_changed` a change of mode logs. */
export const QA_MODE_SETTING = 'qa_mode';

/** QA findings are out of date: a gate asked for them before a sweep. A route's 409. */
export class QaStaleError extends Error {
  constructor(
    message: string,
    /** Edits since the last sweep. */
    readonly unsweptEdits: number,
  ) {
    super(message);
    this.name = 'QaStaleError';
  }
}

/** What a gate says when it refuses stale findings, here and in the CLI. */
export const QA_STALE_MESSAGE =
  'QA has not been run since the last change: run QA for the project first';

interface ModeRow {
  deferred: number;
  unswept_edits: number;
}

const readMode = (db: Database.Database): ModeRow | undefined =>
  db.prepare('SELECT deferred, unswept_edits FROM qa_mode_setting WHERE id = 1').get() as
    ModeRow | undefined;

/** Whether the project runs QA only when asked. No row is live. */
export function isQaDeferred(db: Database.Database): boolean {
  return readMode(db)?.deferred === 1;
}

/** Edits since QA last swept the project; always 0 in live mode, which keeps findings current. */
export function qaUnsweptEdits(db: Database.Database): number {
  const row = readMode(db);
  return row?.deferred === 1 ? row.unswept_edits : 0;
}

/** Whether a deferred project's findings are out of date. Never true in live mode. */
export function isQaStale(db: Database.Database): boolean {
  return qaUnsweptEdits(db) > 0;
}

/**
 * Counts one edit against a deferred project, in the caller's transaction. Live mode
 * counts nothing: there is nothing to catch up on.
 */
export function noteQaDeferredEdit(db: Database.Database): void {
  db.prepare(
    'UPDATE qa_mode_setting SET unswept_edits = unswept_edits + 1 WHERE id = 1 AND deferred = 1',
  ).run();
}

/**
 * Sets the mode. Going live again is refused while findings are stale (`QaStaleError`):
 * live QA would trust rows no sweep has checked, so the sweep comes first. Logs the
 * change; setting the mode it already has writes and logs nothing.
 */
export function setQaDeferred(
  db: Database.Database,
  deferred: boolean,
  actor: AuditActor,
): boolean {
  return db.transaction((): boolean => {
    const from = isQaDeferred(db);
    if (from === deferred) return from;
    if (!deferred) {
      const unswept = qaUnsweptEdits(db);
      if (unswept > 0) throw new QaStaleError(QA_STALE_MESSAGE, unswept);
      db.prepare('DELETE FROM qa_mode_setting WHERE id = 1').run();
    } else {
      db.prepare(
        'INSERT INTO qa_mode_setting (id, deferred, unswept_edits) VALUES (1, 1, 0)',
      ).run();
    }
    appendAuditEvent(db, {
      actor,
      action: 'project.setting_changed',
      subjectType: 'project',
      subjectId: null,
      detail: {
        key: QA_MODE_SETTING,
        from: from ? 'deferred' : 'live',
        to: deferred ? 'deferred' : 'live',
      },
    });
    return deferred;
  })();
}

/**
 * What a gate calls before it reads QA findings: returns when they are current (always
 * in live mode), throws `QaStaleError` when a deferred project has edits no sweep has seen.
 */
export function assertQaCurrent(db: Database.Database): void {
  const unswept = qaUnsweptEdits(db);
  if (unswept > 0) throw new QaStaleError(QA_STALE_MESSAGE, unswept);
}

/**
 * Clears the edits a sweep saw, and only those: an edit that landed after the sweep
 * read the count leaves the project stale, which is the point of counting. Live
 * mode has no row and nothing to clear.
 */
export function clearQaUnswept(db: Database.Database, seen: number): void {
  db.prepare(
    'UPDATE qa_mode_setting SET unswept_edits = unswept_edits - @seen WHERE id = 1 AND deferred = 1 AND unswept_edits >= @seen',
  ).run({ seen });
}
