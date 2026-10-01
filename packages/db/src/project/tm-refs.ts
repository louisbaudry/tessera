/**
 * `tm_ref` repository (v1-spec.md §4.1; backlog #16).
 *
 * Multiple TMs is what "projects, multiple TMs" buys — this module is
 * the plumbing that makes it real: rows ordered by priority (lowest
 * consulted first, per spec), and `ATTACH`ing each `.ctm` onto the
 * project connection so a query can reach across all of them. Actually
 * querying across the attached TMs to produce a match is #19's job, not
 * this module's.
 *
 * Every write names its actor and logs one `project.setting_changed`
 * with key {@link TM_REFS_SETTING} in its own transaction (backlog #32,
 * audit-spec.md §2.4): the whole list before and after, so the log says
 * which memories fed and received a project's work at any point, not
 * only at a pre-translate.
 */

import type { AuditActor, JsonValue, TmRef } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';
import { attachRefs, detachRefs } from './attached-refs.js';

export class TmRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TmRefError';
  }
}

interface TmRefRow {
  id: number;
  path: string;
  priority: number;
  is_write_target: number;
  enabled: number;
}

const fromRow = (row: TmRefRow): TmRef => ({
  id: row.id,
  path: row.path,
  priority: row.priority,
  isWriteTarget: Boolean(row.is_write_target),
  enabled: Boolean(row.enabled),
});

/** The `key` of the `project.setting_changed` every write here logs. */
export const TM_REFS_SETTING = 'tm_refs';

/** The list as the log records it: every row, in consultation order. */
function snapshot(db: Database.Database): JsonValue {
  return listTmRefs(db).map((r) => ({
    id: r.id,
    path: r.path,
    priority: r.priority,
    write_target: r.isWriteTarget,
    enabled: r.enabled,
  }));
}

/**
 * Runs one change to the list and logs it, in one transaction: a change
 * that throws leaves neither the change nor its event.
 */
function changeTmRefs<T>(db: Database.Database, actor: AuditActor, change: () => T): T {
  return db.transaction((): T => {
    const from = snapshot(db);
    const result = change();
    appendAuditEvent(db, {
      actor,
      action: 'project.setting_changed',
      subjectType: 'project',
      subjectId: null,
      detail: { key: TM_REFS_SETTING, from, to: snapshot(db) },
    });
    return result;
  })();
}

const requireRef = (db: Database.Database, id: number): void => {
  if (!db.prepare('SELECT 1 FROM tm_ref WHERE id = ?').get(id)) {
    throw new TmRefError(`no tm_ref with id ${id}`);
  }
};

export interface AddTmRefOptions {
  readonly path: string;
  readonly priority: number;
  /** Makes the new reference the write target, taking it from any other. */
  readonly isWriteTarget?: boolean;
  readonly enabled?: boolean;
  /** Who attached it — required (audit-spec.md decision 3). */
  readonly actor: AuditActor;
}

export function addTmRef(db: Database.Database, options: AddTmRefOptions): TmRef {
  return changeTmRefs(db, options.actor, () => {
    // One change, one event: taking the write target is part of attaching.
    if (options.isWriteTarget) {
      db.prepare('UPDATE tm_ref SET is_write_target = 0 WHERE is_write_target = 1').run();
    }
    const info = db
      .prepare(
        `INSERT INTO tm_ref (path, priority, is_write_target, enabled)
         VALUES (@path, @priority, @is_write_target, @enabled)`,
      )
      .run({
        path: options.path,
        priority: options.priority,
        is_write_target: options.isWriteTarget ? 1 : 0,
        enabled: (options.enabled ?? true) ? 1 : 0,
      });
    return {
      id: info.lastInsertRowid as number,
      path: options.path,
      priority: options.priority,
      isWriteTarget: options.isWriteTarget ?? false,
      enabled: options.enabled ?? true,
    };
  });
}

/** After every reference already there: where an attach without a priority goes. */
export function nextTmPriority(db: Database.Database): number {
  const { max } = db.prepare('SELECT MAX(priority) AS max FROM tm_ref').get() as {
    max: number | null;
  };
  return (max ?? 0) + 1;
}

/**
 * Detaches one memory from the project. The `.ctm` itself is untouched —
 * it may serve other projects; if it was the write target, the project
 * has none until another is chosen.
 */
export function removeTmRef(
  db: Database.Database,
  id: number,
  options: { readonly actor: AuditActor },
): void {
  requireRef(db, id);
  changeTmRefs(db, options.actor, () => {
    db.prepare('DELETE FROM tm_ref WHERE id = ?').run(id);
  });
}

/**
 * Sets the consultation order: `ids` must name every reference exactly
 * once, first consulted first, and they get priorities 1…n. An order,
 * not numbers, because an order is what priority means (§4.1: lowest
 * wins a tie) and a partial renumbering could leave two at one priority.
 */
export function reorderTmRefs(
  db: Database.Database,
  ids: readonly number[],
  options: { readonly actor: AuditActor },
): TmRef[] {
  const current = listTmRefs(db).map((r) => r.id);
  const wanted = new Set(ids);
  if (
    ids.length !== current.length ||
    wanted.size !== ids.length ||
    current.some((id) => !wanted.has(id))
  ) {
    throw new TmRefError(
      `an order must name every attached memory exactly once (have ${current.join(', ') || 'none'})`,
    );
  }
  return changeTmRefs(db, options.actor, () => {
    const set = db.prepare('UPDATE tm_ref SET priority = ? WHERE id = ?');
    ids.forEach((id, i) => set.run(i + 1, id));
    return listTmRefs(db);
  });
}

/** All TM references, lowest priority (consulted first) first. */
export function listTmRefs(db: Database.Database): TmRef[] {
  const rows = db
    .prepare('SELECT * FROM tm_ref ORDER BY priority ASC')
    .all() as TmRefRow[];
  return rows.map(fromRow);
}

/**
 * Makes `id` the sole write target, atomically — clears the previous
 * one and sets the new one in the same transaction, so the partial
 * unique index (`tm_one_write_target`) is never briefly violated and a
 * failure never leaves the project with zero or two write targets.
 */
export function setWriteTarget(
  db: Database.Database,
  id: number,
  options: { readonly actor: AuditActor },
): void {
  requireRef(db, id);
  changeTmRefs(db, options.actor, () => {
    db.prepare('UPDATE tm_ref SET is_write_target = 0 WHERE is_write_target = 1').run();
    db.prepare('UPDATE tm_ref SET is_write_target = 1 WHERE id = ?').run(id);
  });
}

/** The schema alias a `tm_ref` is attached under — stable for its id. */
export function tmAlias(tmRefId: number): string {
  return `tm_${tmRefId}`;
}

/**
 * `ATTACH`es every enabled TM's `.ctm` file onto this connection, in
 * priority order, under {@link tmAlias}. Idempotent; returns the refs
 * actually attached, in order. See `attached-refs.ts` — the mechanism
 * is shared with glossary references.
 */
export function attachTms(db: Database.Database, refs: readonly TmRef[]): TmRef[] {
  return attachRefs(db, refs, tmAlias);
}

/** Detaches every schema {@link attachTms} could have attached for `refs`. */
export function detachTms(db: Database.Database, refs: readonly TmRef[]): void {
  detachRefs(db, refs, tmAlias);
}
