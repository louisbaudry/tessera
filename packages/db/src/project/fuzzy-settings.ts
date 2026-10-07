/**
 * The project's pre-translate fuzzy threshold (`v1-spec.md` §6.1a, 2; issue
 * #139): the lowest FS-2 score pre-translate writes into a segment.
 *
 * Absence-based, like `qa_rule_setting`: no row is the default
 * (`DEFAULT_FUZZY_THRESHOLD`), so a project that never touched it is
 * unchanged. A row with no threshold is fuzzy off. A change is one
 * `project.setting_changed` in the project's log, in the transaction that
 * writes it, as the memory list's is (`tm-refs.ts`).
 */

import {
  DEFAULT_FUZZY_THRESHOLD,
  FUZZY_FLOOR,
  FUZZY_MAX_SCORE,
  isFuzzyThreshold,
  type AuditActor,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';

/** The `key` of the `project.setting_changed` a change here logs. */
export const FUZZY_THRESHOLD_SETTING = 'fuzzy_threshold';

export class FuzzySettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FuzzySettingError';
  }
}

/** What a caller may ask for: a score, off, or the default again. */
export type FuzzyThresholdChoice = number | null | 'default';

/** What a refused threshold says, here and in a run's own option check. */
export const FUZZY_THRESHOLD_MESSAGE = `fuzzy threshold must be a whole number from ${FUZZY_FLOOR} to ${FUZZY_MAX_SCORE}, or off`;

/**
 * The threshold in force: the stored one, `null` for off, or the default
 * when the project has no row.
 */
export function getFuzzyThreshold(db: Database.Database): number | null {
  const row = db.prepare('SELECT threshold FROM fuzzy_setting WHERE id = 1').get() as
    { threshold: number | null } | undefined;
  return row === undefined ? DEFAULT_FUZZY_THRESHOLD : row.threshold;
}

/**
 * Sets the threshold: a score, `null` for off, or `'default'` to remove the
 * row. Logs the change, with the threshold in force before and after (a
 * no-op writes nothing and logs nothing).
 */
export function setFuzzyThreshold(
  db: Database.Database,
  choice: FuzzyThresholdChoice,
  actor: AuditActor,
): number | null {
  if (choice !== null && choice !== 'default' && !isFuzzyThreshold(choice)) {
    throw new FuzzySettingError(FUZZY_THRESHOLD_MESSAGE);
  }
  return db.transaction((): number | null => {
    const from = getFuzzyThreshold(db);
    if (choice === 'default') db.prepare('DELETE FROM fuzzy_setting WHERE id = 1').run();
    else {
      db.prepare(
        `INSERT INTO fuzzy_setting (id, threshold) VALUES (1, @threshold)
         ON CONFLICT (id) DO UPDATE SET threshold = @threshold`,
      ).run({ threshold: choice });
    }
    const to = getFuzzyThreshold(db);
    if (to !== from) {
      appendAuditEvent(db, {
        actor,
        action: 'project.setting_changed',
        subjectType: 'project',
        subjectId: null,
        detail: { key: FUZZY_THRESHOLD_SETTING, from, to },
      });
    }
    return to;
  })();
}
