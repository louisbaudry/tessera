/**
 * Project database schema (v1-spec.md §4.1; backlog #15).
 *
 * SQLite, one file per project. Tags and TM references live alongside
 * the extracted segments; the TM files themselves are separate `.ctm`
 * files, `ATTACH`ed at query time, never copied in.
 */

import {
  fallbackRegionKeys,
  toDocPart,
  type Origin,
  type PartSkeleton,
  type ProjectAuditAction,
  type QaRule,
  type QaSeverity,
  type SegmentStatus,
  type Token,
} from '@cat-tool/core';

import { appendAuditEvent, auditEventDdl } from '../audit/events.js';
import { rebuildTable, sqlList, type Migration } from '../migrate.js';

/** "CATP" — distinct from `.ctm`'s "CATM" (tm-format-spec.md §1). */
export const PROJECT_APPLICATION_ID = 0x43415450;

/*
 * The closed sets below are frozen snapshots, never the live constants
 * (`db/migrate.ts`, backlog #64): each is exactly the list its migration
 * created, and `satisfies` only proves every member still exists.
 * A new member is a new migration, never an edit here.
 */

/** `segment.status` since v1: `SEGMENT_STATUSES` as of 2026-08-30. */
const V1_SEGMENT_STATUSES = [
  'new',
  'draft',
  'translated',
  'confirmed',
  'locked',
] as const satisfies readonly SegmentStatus[];

/**
 * `qa_issue.rule` (v1) and `qa_rule_setting.rule` (v3): `QA_RULES` as of
 * 2026-08-30. It already held all thirteen §6.4 rules then, though only
 * the tag rules had checks until #23/#24; the private development
 * history shows no member added after either migration ran.
 */
const V1_QA_RULES = [
  'tag.missing',
  'tag.extra',
  'tag.unbalanced',
  'seg.empty',
  'seg.untranslated',
  'consistency.target_differs',
  'consistency.source_differs',
  'num.missing',
  'num.altered',
  'punct.terminal',
  'punct.brackets',
  'punct.inverted',
  'punct.spacing',
] as const satisfies readonly QaRule[];

/** `qa_issue.severity` since v1. */
const V1_QA_SEVERITIES = [
  'error',
  'warning',
  'info',
] as const satisfies readonly QaSeverity[];

/** `audit_event.action` since v5: `PROJECT_AUDIT_ACTIONS` as of backlog #56. */
const V5_AUDIT_ACTIONS = [
  'segment.target_set',
  'segment.confirmed',
  'segment.locked',
  'segment.unlocked',
  'segment.baseline',
  'file.added',
  'project.pretranslate',
  'project.exported',
  'project.setting_changed',
  'ai.requested',
] as const satisfies readonly ProjectAuditAction[];

/**
 * `audit_event.action` since v8: v5's list, and `segment.split` and
 * `segment.merged` (backlog #30a, `v1-spec.md` §7.4).
 */
const V8_AUDIT_ACTIONS = [
  'segment.target_set',
  'segment.confirmed',
  'segment.locked',
  'segment.unlocked',
  'segment.baseline',
  'segment.split',
  'segment.merged',
  'file.added',
  'project.pretranslate',
  'project.exported',
  'project.setting_changed',
  'ai.requested',
] as const satisfies readonly ProjectAuditAction[];

/**
 * `audit_event.action` since v9: v8's list, and `qa.dismissed` and
 * `qa.reinstated` (backlog #33, audit-spec.md §2.4).
 */
const V9_AUDIT_ACTIONS = [
  'segment.target_set',
  'segment.confirmed',
  'segment.locked',
  'segment.unlocked',
  'segment.baseline',
  'segment.split',
  'segment.merged',
  'file.added',
  'project.pretranslate',
  'project.exported',
  'project.setting_changed',
  'qa.dismissed',
  'qa.reinstated',
  'ai.requested',
] as const satisfies readonly ProjectAuditAction[];

const v1: Migration = {
  version: 1,
  description: 'initial project schema (v1-spec.md §4.1)',
  up: (db) => {
    db.exec(`
      CREATE TABLE project (
        id             INTEGER PRIMARY KEY CHECK (id = 1),
        name           TEXT NOT NULL,
        src_lang       TEXT NOT NULL,
        tgt_lang       TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        schema_version INTEGER NOT NULL
      );

      CREATE TABLE file (
        id            INTEGER PRIMARY KEY,
        rel_path      TEXT NOT NULL UNIQUE,
        original_blob BLOB NOT NULL,
        skeleton      TEXT NOT NULL,
        part_map      TEXT NOT NULL,
        imported_at   TEXT NOT NULL
      );

      CREATE TABLE segment (
        id            INTEGER PRIMARY KEY,
        file_id       INTEGER NOT NULL REFERENCES file(id),
        part          TEXT NOT NULL,
        ord           INTEGER NOT NULL,
        para_key      TEXT NOT NULL,
        para_ord      INTEGER NOT NULL,
        source_tokens TEXT NOT NULL,
        format_table  TEXT NOT NULL,
        target_tokens TEXT,
        source_hash   TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN (${sqlList(V1_SEGMENT_STATUSES)})),
        origin        TEXT,
        locked        INTEGER NOT NULL DEFAULT 0,
        updated_at    TEXT NOT NULL,
        UNIQUE (file_id, ord)
      );
      CREATE INDEX segment_hash ON segment(source_hash);

      CREATE TABLE tm_ref (
        id              INTEGER PRIMARY KEY,
        path            TEXT NOT NULL,
        priority        INTEGER NOT NULL,
        is_write_target INTEGER NOT NULL DEFAULT 0,
        enabled         INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX tm_one_write_target
        ON tm_ref(is_write_target) WHERE is_write_target = 1;

      CREATE TABLE qa_issue (
        id         INTEGER PRIMARY KEY,
        segment_id INTEGER NOT NULL REFERENCES segment(id),
        rule       TEXT NOT NULL CHECK (rule IN (${sqlList(V1_QA_RULES)})),
        severity   TEXT NOT NULL CHECK (severity IN (${sqlList(V1_QA_SEVERITIES)})),
        message    TEXT NOT NULL,
        dismissed  INTEGER NOT NULL DEFAULT 0,
        run_at     TEXT NOT NULL
      );
    `);
  },
};

const v2: Migration = {
  version: 2,
  description:
    'glossary_ref — .ctg files attached like TMs (smart-glossary-spec.md §2.1, backlog #39)',
  up: (db) => {
    db.exec(`
      CREATE TABLE glossary_ref (
        id              INTEGER PRIMARY KEY,
        path            TEXT NOT NULL,
        priority        INTEGER NOT NULL,
        is_write_target INTEGER NOT NULL DEFAULT 0,
        enabled         INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX glossary_one_write_target
        ON glossary_ref(is_write_target) WHERE is_write_target = 1;
    `);
  },
};

const v3: Migration = {
  version: 3,
  description:
    'qa_rule_setting — per-project rule switches (v1-spec.md §6.4, backlog #22)',
  up: (db) => {
    db.exec(`
      CREATE TABLE qa_rule_setting (
        rule    TEXT PRIMARY KEY CHECK (rule IN (${sqlList(V1_QA_RULES)})),
        enabled INTEGER NOT NULL DEFAULT 1
      );
    `);
  },
};

const v4: Migration = {
  version: 4,
  description:
    'qa_untranslated_allowlist — per-project seg.untranslated suppression by source_hash (v1-spec.md §6.4, backlog #23)',
  up: (db) => {
    db.exec(`
      CREATE TABLE qa_untranslated_allowlist (
        source_hash TEXT PRIMARY KEY,
        added_at    TEXT NOT NULL
      );
    `);
  },
};

/** The actor of everything the migration itself writes (audit-spec.md §6). */
const MIGRATION_ACTOR = {
  actor: { kind: 'system', name: 'migration' },
  label: null,
} as const;

const v5: Migration = {
  version: 5,
  description:
    'audit_event, and a segment.baseline per segment with a target (audit-spec.md §2, §6; backlog #56)',
  up: (db) => {
    db.exec(auditEventDdl(V5_AUDIT_ACTIONS));
    // "This is what it was when recording began" — never an invented author.
    const rows = db
      .prepare(
        `SELECT id, status, origin, target_tokens FROM segment
         WHERE target_tokens IS NOT NULL ORDER BY id`,
      )
      .all() as Array<{
      id: number;
      status: SegmentStatus;
      origin: Origin | null;
      target_tokens: string;
    }>;
    for (const row of rows) {
      appendAuditEvent(db, {
        actor: MIGRATION_ACTOR,
        action: 'segment.baseline',
        subjectType: 'segment',
        subjectId: String(row.id),
        detail: {
          status: row.status,
          origin: row.origin,
          target_tokens: JSON.parse(row.target_tokens) as readonly Token[],
        },
      });
    }
  },
};

const v6: Migration = {
  version: 6,
  description:
    "qa_issue_segment — an index on qa_issue(segment_id); every read of a segment's issues scanned the table (v1-spec.md §4.1, backlog #28)",
  up: (db) => {
    db.exec('CREATE INDEX qa_issue_segment ON qa_issue(segment_id);');
  },
};

/**
 * `qa_issue` and `qa_rule_setting` rebuilt with today's thirteen rules
 * (backlog #64). Defensive: no file is known to hold a narrower list,
 * but a CHECK built from a live list could have, and this repairs any
 * that does. It is also {@link rebuildTable}'s first use, ahead of the
 * widening #44 needs. Every row and id is kept; `qa_issue_segment`
 * (v6) goes with the old table and is recreated here. The DDL is v1's
 * and v3's, written out again rather than shared: a function both
 * migrations called would be a live definition, the bug this fixes.
 */
const V7_QA_RULES = [
  'tag.missing',
  'tag.extra',
  'tag.unbalanced',
  'seg.empty',
  'seg.untranslated',
  'consistency.target_differs',
  'consistency.source_differs',
  'num.missing',
  'num.altered',
  'punct.terminal',
  'punct.brackets',
  'punct.inverted',
  'punct.spacing',
] as const satisfies readonly QaRule[];

const v7: Migration = {
  version: 7,
  description:
    'qa_issue and qa_rule_setting rebuilt from a frozen rule list (db/migrate.ts, backlog #64)',
  up: (db) => {
    rebuildTable(
      db,
      'qa_issue',
      `
      CREATE TABLE qa_issue (
        id         INTEGER PRIMARY KEY,
        segment_id INTEGER NOT NULL REFERENCES segment(id),
        rule       TEXT NOT NULL CHECK (rule IN (${sqlList(V7_QA_RULES)})),
        severity   TEXT NOT NULL CHECK (severity IN (${sqlList(V1_QA_SEVERITIES)})),
        message    TEXT NOT NULL,
        dismissed  INTEGER NOT NULL DEFAULT 0,
        run_at     TEXT NOT NULL
      );
      CREATE INDEX qa_issue_segment ON qa_issue(segment_id);
    `,
    );
    rebuildTable(
      db,
      'qa_rule_setting',
      `
      CREATE TABLE qa_rule_setting (
        rule    TEXT PRIMARY KEY CHECK (rule IN (${sqlList(V7_QA_RULES)})),
        enabled INTEGER NOT NULL DEFAULT 1
      );
    `,
    );
  },
};

const v8: Migration = {
  version: 8,
  description:
    'audit_event widened with segment.split and segment.merged (v1-spec.md §7.4, backlog #30a)',
  up: (db) => {
    // Rows, ids, hashes and the append-only triggers all survive: the
    // table is rebuilt, never rewritten (`rebuildTable`, backlog #64).
    rebuildTable(db, 'audit_event', auditEventDdl(V8_AUDIT_ACTIONS));
  },
};

const v9: Migration = {
  version: 9,
  description:
    'audit_event widened with qa.dismissed and qa.reinstated (audit-spec.md §2.4, backlog #33)',
  up: (db) => {
    rebuildTable(db, 'audit_event', auditEventDdl(V9_AUDIT_ACTIONS));
  },
};

/**
 * `segment.fallback_copy` (backlog #34, v1-spec.md §3.6): the segment is
 * inside an `mc:Fallback`, the second copy of a text box, so the editor's
 * progress and vendor pay count it once. Recorded at assembly from now
 * on; a file already here is read once, from the skeleton it stored —
 * the same scan the upload count makes, and a fact of the document, so
 * nothing about it can be different on a later day.
 */
const v10: Migration = {
  version: 10,
  description:
    'segment.fallback_copy, backfilled from the skeleton each file stored (v1-spec.md §3.6, backlog #34)',
  up: (db) => {
    db.exec('ALTER TABLE segment ADD COLUMN fallback_copy INTEGER NOT NULL DEFAULT 0;');
    const mark = db.prepare(
      'UPDATE segment SET fallback_copy = 1 WHERE file_id = ? AND part = ? AND para_key = ?',
    );
    const files = db.prepare('SELECT id, skeleton FROM file').all() as Array<{
      id: number;
      skeleton: string;
    }>;
    for (const file of files) {
      for (const sk of JSON.parse(file.skeleton) as PartSkeleton[]) {
        const part = toDocPart(sk.part);
        for (const key of fallbackRegionKeys(sk)) mark.run(file.id, part, key);
      }
    }
  },
};

/**
 * `qa_issue` and `qa_rule_setting` widened with `term.glossary_mismatch`
 * (backlog #44), `rebuildTable`'s second use. The v7 DDL again with one
 * more member in a fresh literal; every row and id is kept, and the rule
 * starts enabled everywhere, `qa_rule_setting` being absence-based.
 */
const V11_QA_RULES = [
  ...V7_QA_RULES,
  'term.glossary_mismatch',
] as const satisfies readonly QaRule[];

const v11: Migration = {
  version: 11,
  description:
    'qa_issue and qa_rule_setting widened with term.glossary_mismatch (smart-glossary-spec.md §6, backlog #44)',
  up: (db) => {
    rebuildTable(
      db,
      'qa_issue',
      `
      CREATE TABLE qa_issue (
        id         INTEGER PRIMARY KEY,
        segment_id INTEGER NOT NULL REFERENCES segment(id),
        rule       TEXT NOT NULL CHECK (rule IN (${sqlList(V11_QA_RULES)})),
        severity   TEXT NOT NULL CHECK (severity IN (${sqlList(V1_QA_SEVERITIES)})),
        message    TEXT NOT NULL,
        dismissed  INTEGER NOT NULL DEFAULT 0,
        run_at     TEXT NOT NULL
      );
      CREATE INDEX qa_issue_segment ON qa_issue(segment_id);
    `,
    );
    rebuildTable(
      db,
      'qa_rule_setting',
      `
      CREATE TABLE qa_rule_setting (
        rule    TEXT PRIMARY KEY CHECK (rule IN (${sqlList(V11_QA_RULES)})),
        enabled INTEGER NOT NULL DEFAULT 1
      );
    `,
    );
  },
};

/**
 * `fuzzy_setting` (backlog #61, issue #139): the project's pre-translate
 * fuzzy threshold, one row at most. **Absence-based**, like
 * `qa_rule_setting`: no row means the default (75, `DEFAULT_FUZZY_THRESHOLD`),
 * so no existing project changes. A row with a NULL threshold is fuzzy off.
 * The range is a frozen literal, as every closed set in a migration is: it is
 * the floor and the best score a fuzzy match can have as of v12, and
 * `fuzzy-settings.test.ts` ties it to `FUZZY_FLOOR` and the top score.
 */
const v12: Migration = {
  version: 12,
  description:
    "fuzzy_setting — the project's pre-translate fuzzy threshold (v1-spec.md §6.1a, issue #139)",
  up: (db) => {
    db.exec(`
      CREATE TABLE fuzzy_setting (
        id        INTEGER PRIMARY KEY CHECK (id = 1),
        threshold INTEGER CHECK (threshold IS NULL OR threshold BETWEEN 50 AND 99)
      );
    `);
  },
};

/**
 * `origin` has no CHECK constraint: it is a deliberately open string
 * (`v1-spec.md` §4.3) so a future match kind — `tm_fuzzy_85`, `tm_ice` —
 * is just a new value, never a migration.
 */
export const PROJECT_MIGRATIONS: readonly Migration[] = [
  v1,
  v2,
  v3,
  v4,
  v5,
  v6,
  v7,
  v8,
  v9,
  v10,
  v11,
  v12,
];
