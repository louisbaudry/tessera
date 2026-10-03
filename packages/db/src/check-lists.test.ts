/**
 * The guard for backlog #64: every closed-set `CHECK (x IN (...))` a
 * fresh file carries equals the constant it snapshots.
 *
 * Migrations write their lists as literals (`db/migrate.ts`), so adding
 * a member to a constant changes nothing on disk until a migration
 * widens the CHECK. This test is what notices the missing migration: a
 * fresh file still holds the old list, and the constant no longer
 * matches it. A CHECK list nobody registered below fails too, so a new
 * closed set can't slip past the guard by being new.
 */

import {
  ACCOUNT_ROLES,
  DECISION_KINDS,
  PLATFORM_AUDIT_ACTIONS,
  PORTAL_AUDIT_ACTIONS,
  PROJECT_AUDIT_ACTIONS,
  PROJECT_SCOPES,
  QA_RULES,
  QA_SEVERITIES,
  SEGMENT_STATUSES,
} from '@cat-tool/core';
import { ORDER_STATUSES } from '@cat-tool/portal-core';
import { describe, expect, it } from 'vitest';

import { GLOSSARY_APPLICATION_ID, GLOSSARY_MIGRATIONS } from './glossary/schema.js';
import { openAndMigrate, type Migration } from './migrate.js';
import { PLATFORM_APPLICATION_ID, PLATFORM_MIGRATIONS } from './platform/schema.js';
import { PORTAL_APPLICATION_ID, PORTAL_MIGRATIONS } from './portal/schema.js';
import { PROJECT_APPLICATION_ID, PROJECT_MIGRATIONS } from './project/schema.js';
import { TM_APPLICATION_ID, TM_MIGRATIONS } from './tm/schema.js';

interface Case {
  readonly applicationId: number;
  readonly migrations: readonly Migration[];
  /** `table.column` → the list its CHECK must hold, in order. */
  readonly lists: Readonly<Record<string, readonly string[]>>;
}

const DATABASES: Readonly<Record<string, Case>> = {
  project: {
    applicationId: PROJECT_APPLICATION_ID,
    migrations: PROJECT_MIGRATIONS,
    lists: {
      'segment.status': SEGMENT_STATUSES,
      'qa_issue.rule': QA_RULES,
      'qa_issue.severity': QA_SEVERITIES,
      'qa_rule_setting.rule': QA_RULES,
      'audit_event.action': PROJECT_AUDIT_ACTIONS,
    },
  },
  glossary: {
    applicationId: GLOSSARY_APPLICATION_ID,
    migrations: GLOSSARY_MIGRATIONS,
    lists: { 'term_decision.kind': DECISION_KINDS },
  },
  portal: {
    applicationId: PORTAL_APPLICATION_ID,
    migrations: PORTAL_MIGRATIONS,
    lists: {
      'translation_order.status': ORDER_STATUSES,
      'audit_event.action': PORTAL_AUDIT_ACTIONS,
    },
  },
  platform: {
    applicationId: PLATFORM_APPLICATION_ID,
    migrations: PLATFORM_MIGRATIONS,
    lists: {
      'audit_event.action': PLATFORM_AUDIT_ACTIONS,
      'account.role': ACCOUNT_ROLES,
      'project_authorization.scope': PROJECT_SCOPES,
    },
  },
  tm: {
    applicationId: TM_APPLICATION_ID,
    migrations: TM_MIGRATIONS,
    // No constant: `tm_import` records TMX runs only (tm-format-spec.md
    // §2.9); `.sdltm` imports never write one.
    lists: { 'tm_import.format': ['tmx'] },
  },
};

/** Every `CHECK (col IN ('a', 'b'))` in a fresh file, keyed `table.column`. */
function checkLists(c: Case): Record<string, string[]> {
  const db = openAndMigrate(':memory:', c);
  try {
    const rows = db
      .prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ tbl_name: string; sql: string }>;
    const found: Record<string, string[]> = {};
    for (const row of rows) {
      for (const [, column, list] of row.sql.matchAll(
        /CHECK \((\w+) IN \(([^)]*)\)\)/g,
      )) {
        found[`${row.tbl_name}.${column}`] = list!
          .split(',')
          .map((v) => v.trim().replace(/^'|'$/g, ''));
      }
    }
    return found;
  } finally {
    db.close();
  }
}

describe('a fresh file’s CHECK lists equal the live constants (backlog #64)', () => {
  for (const [name, c] of Object.entries(DATABASES)) {
    it(name, () => {
      expect(checkLists(c)).toEqual(c.lists);
    });
  }
});
