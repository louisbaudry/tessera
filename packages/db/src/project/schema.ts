/**
 * Project database schema (v1-spec.md §4.1; backlog #15).
 *
 * SQLite, one file per project. Tags and TM references live alongside
 * the extracted segments; the TM files themselves are separate `.ctm`
 * files, `ATTACH`ed at query time, never copied in.
 */

import { QA_RULES, SEGMENT_STATUSES, type QaSeverity } from '@cat-tool/core';

import type { Migration } from '../migrate.js';

/** "CATP" — distinct from `.ctm`'s "CATM" (tm-format-spec.md §1). */
export const PROJECT_APPLICATION_ID = 0x43415450;

const QA_SEVERITIES: readonly QaSeverity[] = ['error', 'warning', 'info'];

const sqlList = (values: readonly string[]): string =>
  values.map((v) => `'${v}'`).join(', ');

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
        status        TEXT NOT NULL CHECK (status IN (${sqlList(SEGMENT_STATUSES)})),
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
        rule       TEXT NOT NULL CHECK (rule IN (${sqlList(QA_RULES)})),
        severity   TEXT NOT NULL CHECK (severity IN (${sqlList(QA_SEVERITIES)})),
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
        rule    TEXT PRIMARY KEY CHECK (rule IN (${sqlList(QA_RULES)})),
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

/**
 * `origin` has no CHECK constraint: it is a deliberately open string
 * (`v1-spec.md` §4.3) so a future match kind — `tm_fuzzy_85`, `tm_ice` —
 * is just a new value, never a migration.
 */
export const PROJECT_MIGRATIONS: readonly Migration[] = [v1, v2, v3, v4];
