/**
 * `tm_ref` repository (v1-spec.md §4.1; backlog #16).
 *
 * Multiple TMs is what "projects, multiple TMs" buys — this module is
 * the plumbing that makes it real: rows ordered by priority (lowest
 * consulted first, per spec), and `ATTACH`ing each `.ctm` onto the
 * project connection so a query can reach across all of them. Actually
 * querying across the attached TMs to produce a match is #19's job, not
 * this module's.
 */

import type { TmRef } from '@cat-tool/core';
import type Database from 'better-sqlite3';

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

export interface AddTmRefOptions {
  readonly path: string;
  readonly priority: number;
  readonly isWriteTarget?: boolean;
  readonly enabled?: boolean;
}

export function addTmRef(db: Database.Database, options: AddTmRefOptions): TmRef {
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
export function setWriteTarget(db: Database.Database, id: number): void {
  const exists = db.prepare('SELECT 1 FROM tm_ref WHERE id = ?').get(id);
  if (!exists) {
    throw new TmRefError(`no tm_ref with id ${id}`);
  }
  db.transaction(() => {
    db.prepare('UPDATE tm_ref SET is_write_target = 0 WHERE is_write_target = 1').run();
    db.prepare('UPDATE tm_ref SET is_write_target = 1 WHERE id = ?').run(id);
  })();
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
