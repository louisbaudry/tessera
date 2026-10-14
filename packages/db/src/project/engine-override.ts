/**
 * The draft engine a project asks for (backlog #133,
 * `planning/translation-engine-spec.md` D8): `off`, an engine, or none to
 * inherit the client's default.
 *
 * Absence-based, like `fuzzy_setting`: no row inherits, so no existing project
 * changes. It is only a request. What may be used is the client's consent in
 * `platform.sqlite`, and `resolveEngine` (`core/draft/engine.ts`) turns an
 * override to an engine the client did not consent to into `off`: a project
 * can narrow what its client allows, never widen it. A change is one
 * `project.setting_changed` in the project's log, in the transaction that
 * writes it.
 */

import { isEngineChoice, type AuditActor, type EngineChoice } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';

/** The `key` of the `project.setting_changed` a change here logs. */
export const ENGINE_OVERRIDE_SETTING = 'engine_override';

export class EngineOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineOverrideError';
  }
}

/** What the project asks for, or `null` to inherit the client's default. */
export function getEngineOverride(db: Database.Database): EngineChoice | null {
  const row = db
    .prepare('SELECT engine FROM engine_override_setting WHERE id = 1')
    .get() as { engine: EngineChoice } | undefined;
  return row === undefined ? null : row.engine;
}

/**
 * Sets the override (`off` or an engine), or clears it with `null` to inherit.
 * Logs the change, from and to; changing nothing writes and logs nothing.
 * Throws {@link EngineOverrideError} for a value that is not an engine choice.
 */
export function setEngineOverride(
  db: Database.Database,
  engine: EngineChoice | null,
  actor: AuditActor,
): EngineChoice | null {
  if (engine !== null && !isEngineChoice(engine)) {
    throw new EngineOverrideError(`"${String(engine)}" is not an engine`);
  }
  return db.transaction((): EngineChoice | null => {
    const from = getEngineOverride(db);
    if (engine === null) {
      db.prepare('DELETE FROM engine_override_setting WHERE id = 1').run();
    } else {
      db.prepare(
        `INSERT INTO engine_override_setting (id, engine) VALUES (1, @engine)
         ON CONFLICT (id) DO UPDATE SET engine = @engine`,
      ).run({ engine });
    }
    if (engine !== from) {
      appendAuditEvent(db, {
        actor,
        action: 'project.setting_changed',
        subjectType: 'project',
        subjectId: null,
        detail: { key: ENGINE_OVERRIDE_SETTING, from, to: engine },
      });
    }
    return engine;
  })();
}
