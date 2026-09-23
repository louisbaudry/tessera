/**
 * `qa_rule_setting` repository — per-project rule switches (v1-spec.md §6.4;
 * backlog #22).
 *
 * A rule with no row is enabled. `qa_rule_setting` only ever holds rows for
 * rules someone has explicitly turned off, so a rule added to `QA_RULES`
 * later is on for every existing project without a migration touching
 * their data — the same reasoning `segment.origin`'s missing CHECK
 * constraint documents for itself in `schema.ts`, applied to a settings
 * table instead of a column.
 */

import { QA_RULES, type QaRule } from '@cat-tool/core';
import type Database from 'better-sqlite3';

export function isRuleEnabled(db: Database.Database, rule: QaRule): boolean {
  const row = db
    .prepare('SELECT enabled FROM qa_rule_setting WHERE rule = ?')
    .get(rule) as { enabled: number } | undefined;
  return row === undefined || row.enabled !== 0;
}

export function setRuleEnabled(
  db: Database.Database,
  rule: QaRule,
  enabled: boolean,
): void {
  db.prepare(
    `INSERT INTO qa_rule_setting (rule, enabled) VALUES (@rule, @enabled)
     ON CONFLICT (rule) DO UPDATE SET enabled = @enabled`,
  ).run({ rule, enabled: enabled ? 1 : 0 });
}

/** Every rule this project has switched on, for `runQaChecks`'s `enabledRules`. */
export function listEnabledRules(db: Database.Database): ReadonlySet<QaRule> {
  const disabled = new Set(
    (
      db.prepare('SELECT rule FROM qa_rule_setting WHERE enabled = 0').all() as {
        rule: QaRule;
      }[]
    ).map((row) => row.rule),
  );
  return new Set(QA_RULES.filter((rule) => !disabled.has(rule)));
}
