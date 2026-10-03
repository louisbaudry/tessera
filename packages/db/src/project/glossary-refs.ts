/**
 * `glossary_ref` repository (smart-glossary-spec.md §2.1; backlog #39).
 *
 * A client `.ctg` attached over a base `.ctg` is `tm_ref` with the
 * vocabulary changed: rows ordered by priority (lowest consulted
 * first), each file `ATTACH`ed under a stable alias, and — unlike
 * `tm-refs.ts`, whose cross-TM query is #19's — the resolution across
 * attached glossaries lives here too (`resolveRendering`), because it is
 * one loop over `findRendering` and nothing more.
 *
 * Every write names its actor and logs one `project.setting_changed`
 * with key {@link GLOSSARY_REFS_SETTING} in its own transaction, as
 * `tm-refs.ts` does (audit-spec.md §2.4): the whole list before and
 * after. Until backlog #43a nothing called these from a request, so
 * they logged nothing; the first route to attach a glossary made that a
 * hole in the log.
 */

import type { AuditActor, GlossaryRef, JsonValue } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';
import { findRendering } from '../glossary/terms.js';
import type { FindRenderingParams, Rendering } from '../glossary/terms.js';
import { attachRefs, detachRefs } from './attached-refs.js';

export class GlossaryRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlossaryRefError';
  }
}

interface GlossaryRefRow {
  id: number;
  path: string;
  priority: number;
  is_write_target: number;
  enabled: number;
}

const fromRow = (row: GlossaryRefRow): GlossaryRef => ({
  id: row.id,
  path: row.path,
  priority: row.priority,
  isWriteTarget: Boolean(row.is_write_target),
  enabled: Boolean(row.enabled),
});

/** The `key` of the `project.setting_changed` every write here logs. */
export const GLOSSARY_REFS_SETTING = 'glossary_refs';

/** The list as the log records it: every row, in consultation order. */
function snapshot(db: Database.Database): JsonValue {
  return listGlossaryRefs(db).map((r) => ({
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
function changeGlossaryRefs<T>(
  db: Database.Database,
  actor: AuditActor,
  change: () => T,
): T {
  return db.transaction((): T => {
    const from = snapshot(db);
    const result = change();
    appendAuditEvent(db, {
      actor,
      action: 'project.setting_changed',
      subjectType: 'project',
      subjectId: null,
      detail: { key: GLOSSARY_REFS_SETTING, from, to: snapshot(db) },
    });
    return result;
  })();
}

export interface AddGlossaryRefOptions {
  readonly path: string;
  readonly priority: number;
  /** Makes the new reference the write target, taking it from any other. */
  readonly isWriteTarget?: boolean;
  readonly enabled?: boolean;
  /** Who attached it — required (audit-spec.md decision 3). */
  readonly actor: AuditActor;
}

export function addGlossaryRef(
  db: Database.Database,
  options: AddGlossaryRefOptions,
): GlossaryRef {
  return changeGlossaryRefs(db, options.actor, () => {
    // One change, one event: taking the write target is part of attaching.
    if (options.isWriteTarget) {
      db.prepare(
        'UPDATE glossary_ref SET is_write_target = 0 WHERE is_write_target = 1',
      ).run();
    }
    const info = db
      .prepare(
        `INSERT INTO glossary_ref (path, priority, is_write_target, enabled)
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
export function nextGlossaryPriority(db: Database.Database): number {
  const { max } = db.prepare('SELECT MAX(priority) AS max FROM glossary_ref').get() as {
    max: number | null;
  };
  return (max ?? 0) + 1;
}

/** All glossary references, lowest priority (consulted first) first. */
export function listGlossaryRefs(db: Database.Database): GlossaryRef[] {
  const rows = db
    .prepare('SELECT * FROM glossary_ref ORDER BY priority ASC')
    .all() as GlossaryRefRow[];
  return rows.map(fromRow);
}

/**
 * Makes `id` the sole write target atomically — the glossary a session's
 * decisions are committed to. Same one-transaction discipline as
 * `setWriteTarget` for TMs, for the same partial-unique-index reason.
 */
export function setGlossaryWriteTarget(
  db: Database.Database,
  id: number,
  options: { readonly actor: AuditActor },
): void {
  const exists = db.prepare('SELECT 1 FROM glossary_ref WHERE id = ?').get(id);
  if (!exists) {
    throw new GlossaryRefError(`no glossary_ref with id ${id}`);
  }
  changeGlossaryRefs(db, options.actor, () => {
    db.prepare(
      'UPDATE glossary_ref SET is_write_target = 0 WHERE is_write_target = 1',
    ).run();
    db.prepare('UPDATE glossary_ref SET is_write_target = 1 WHERE id = ?').run(id);
  });
}

/** The schema alias a `glossary_ref` is attached under — stable for its id. */
export function glossaryAlias(refId: number): string {
  return `gl_${refId}`;
}

/** `ATTACH`es every enabled glossary in priority order; idempotent. */
export function attachGlossaries(
  db: Database.Database,
  refs: readonly GlossaryRef[],
): GlossaryRef[] {
  return attachRefs(db, refs, glossaryAlias);
}

export function detachGlossaries(
  db: Database.Database,
  refs: readonly GlossaryRef[],
): void {
  detachRefs(db, refs, glossaryAlias);
}

/**
 * The rendering a project should propose for a source term: the first
 * attached glossary, in priority order, that has one. A client glossary
 * at priority 1 over a base glossary at priority 2 therefore returns the
 * client's rendering and falls through to the base's only when the
 * client has none — inheritance is priority, not a separate concept
 * (smart-glossary-spec.md §2.1). Disabled refs are never consulted.
 *
 * `refs` must already be attached (`attachGlossaries`).
 */
export function resolveRendering(
  db: Database.Database,
  refs: readonly GlossaryRef[],
  params: FindRenderingParams,
): Rendering | null {
  const ordered = [...refs]
    .filter((r) => r.enabled)
    .sort((a, b) => a.priority - b.priority);
  for (const ref of ordered) {
    const found = findRendering(db, params, { schema: glossaryAlias(ref.id) });
    if (found.length > 0) return found[0]!;
  }
  return null;
}
