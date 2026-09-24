/**
 * `.ctm` translation-memory schema (`tm-format-spec.md` §2; backlog #15a).
 *
 * The full multilingual model: a unit (`tu`) is a language-neutral
 * identity, with one variant (`tuv`) per language. This ships whole in
 * format version 1 — including `seg_profile` and the reserved `tuv_vec`
 * table — because no `.ctm` file has ever been written, so there is
 * nothing to migrate away from yet.
 *
 * What this module does *not* do: the project-token ↔ `TmToken` mapping
 * (#15c, done — `@cat-tool/core/tm/mapping.ts`), merge (#15d), and the
 * pair-retrieval query (#15e, done — `retrieve.ts`). Each is its own
 * backlog item, deliberately.
 */

import { NORMALIZER_VERSION } from '@cat-tool/core';

import type { Migration } from '../migrate.js';

/** "CATM" — tm-format-spec.md §1. */
export const TM_APPLICATION_ID = 0x4341544d;

/**
 * The segmentation logic version, stamped into every `.ctm` file at
 * creation so a reader can detect drift and re-segment rather than
 * trust a stale value. Not yet consumed by anything real — segmentation
 * itself has no versioning story yet — declared here because the `tm`
 * row needs a value for the column from its first insert.
 *
 * `NORMALIZER_VERSION` is *not* declared here: it names an actual rule
 * set (`@cat-tool/core/tm/normalize.ts`, backlog #17) and is imported
 * from there, not duplicated — the mistake `primarySubtag` already
 * taught this codebase once (backlog #15e).
 */
export const TOKENIZER_VERSION = 1;
export { NORMALIZER_VERSION };

/**
 * `tm-format-spec.md` §6's quality table, in one place.
 *
 * Every row, not only the ones with a caller today: a partial copy of a
 * five-row table is how the second copy starts. Two modules had spelled
 * out "2" independently before this existed — `write.ts` as
 * `CONFIRMED_QUALITY` (what a translator confirming a segment records)
 * and `import-common.ts` as `DEFAULT_IMPORTED_QUALITY` (what this
 * project assumes about someone else's memory). Different questions,
 * the same row, and nothing linking them.
 *
 * Retrieval prefers the highest quality on a tie and write-back never
 * lowers an existing variant's, so these values are ordered, not just
 * distinct — which is exactly why they cannot drift apart in two files.
 */
export const QUALITY = {
  /** Machine translation, unedited. */
  machine: 0,
  /** Draft — translated, not confirmed. */
  draft: 1,
  /** Confirmed by the translator. */
  confirmed: 2,
  /** Reviewed / approved by a second pair of eyes. */
  reviewed: 3,
  /** Client-approved or authority reference. */
  approved: 4,
} as const;

export type Quality = (typeof QUALITY)[keyof typeof QUALITY];

const v1: Migration = {
  version: 1,
  description: 'initial multilingual TM schema (tm-format-spec.md §2)',
  up: (db) => {
    db.exec(`
      CREATE TABLE tm (
        id                 INTEGER PRIMARY KEY CHECK (id = 1),
        uuid               TEXT    NOT NULL UNIQUE,
        name               TEXT    NOT NULL,
        langs              TEXT    NOT NULL,
        created_at         TEXT    NOT NULL,
        format_version     INTEGER NOT NULL,
        generator          TEXT    NOT NULL,
        normalizer_version INTEGER NOT NULL,
        tokenizer_version  INTEGER NOT NULL,
        read_only          INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE tu (
        id             INTEGER PRIMARY KEY,
        uuid           TEXT    NOT NULL UNIQUE,
        rev            INTEGER NOT NULL DEFAULT 1,
        created_at     TEXT    NOT NULL,
        updated_at     TEXT    NOT NULL,
        created_by     TEXT,
        origin_doc     TEXT,
        origin_project TEXT,
        deleted        INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX tu_updated ON tu(updated_at);

      CREATE TABLE tuv (
        id           INTEGER PRIMARY KEY,
        tu_id        INTEGER NOT NULL REFERENCES tu(id) ON DELETE CASCADE,
        lang         TEXT    NOT NULL,
        rev          INTEGER NOT NULL DEFAULT 1,

        tokens       TEXT    NOT NULL,
        plain        TEXT    NOT NULL,
        hash         TEXT    NOT NULL,

        prev_hash    TEXT,
        next_hash    TEXT,

        -- QUALITY.draft. Spelled out rather than interpolated: a migration
        -- is a historical record, and a schema v1 file created last year
        -- must still be describable by this exact DDL even if the
        -- constant above were ever renumbered.
        quality      INTEGER NOT NULL DEFAULT 1,
        usage_count  INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,

        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL,
        updated_by   TEXT,

        UNIQUE (tu_id, lang)
      );
      CREATE INDEX tuv_lookup ON tuv(lang, hash);
      CREATE INDEX tuv_ctx    ON tuv(lang, hash, prev_hash, next_hash);

      CREATE TABLE tu_attr (
        tu_id INTEGER NOT NULL REFERENCES tu(id) ON DELETE CASCADE,
        key   TEXT    NOT NULL,
        value TEXT    NOT NULL,
        PRIMARY KEY (tu_id, key)
      ) WITHOUT ROWID;
      CREATE INDEX tu_attr_kv ON tu_attr(key, value);

      CREATE TABLE tuv_history (
        tuv_id     INTEGER NOT NULL REFERENCES tuv(id) ON DELETE CASCADE,
        rev        INTEGER NOT NULL,
        tokens     TEXT    NOT NULL,
        quality    INTEGER NOT NULL,
        changed_at TEXT    NOT NULL,
        changed_by TEXT,
        PRIMARY KEY (tuv_id, rev)
      ) WITHOUT ROWID;

      CREATE VIRTUAL TABLE tuv_fts USING fts5(
        plain,
        content = 'tuv',
        content_rowid = 'id',
        tokenize = 'unicode61 remove_diacritics 2'
      );

      -- Standard fts5 external-content sync triggers: the index is a
      -- projection of tuv.plain, never written to directly.
      CREATE TRIGGER tuv_fts_ai AFTER INSERT ON tuv BEGIN
        INSERT INTO tuv_fts(rowid, plain) VALUES (new.id, new.plain);
      END;
      CREATE TRIGGER tuv_fts_ad AFTER DELETE ON tuv BEGIN
        INSERT INTO tuv_fts(tuv_fts, rowid, plain) VALUES ('delete', old.id, old.plain);
      END;
      CREATE TRIGGER tuv_fts_au AFTER UPDATE ON tuv BEGIN
        INSERT INTO tuv_fts(tuv_fts, rowid, plain) VALUES ('delete', old.id, old.plain);
        INSERT INTO tuv_fts(rowid, plain) VALUES (new.id, new.plain);
      END;

      CREATE TABLE seg_profile (
        lang  TEXT PRIMARY KEY,
        delta TEXT NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE tuv_vec (
        tuv_id INTEGER NOT NULL REFERENCES tuv(id) ON DELETE CASCADE,
        model  TEXT    NOT NULL,
        dim    INTEGER NOT NULL,
        vec    BLOB    NOT NULL,
        PRIMARY KEY (tuv_id, model)
      ) WITHOUT ROWID;
    `);
  },
};

const v2: Migration = {
  version: 2,
  description: 'tm_import: import runs, their progress and incomplete state (§2.9)',
  up: (db) => {
    db.exec(`
      CREATE TABLE tm_import (
        id            INTEGER PRIMARY KEY,
        format        TEXT    NOT NULL CHECK (format IN ('tmx')),
        source_name   TEXT    NOT NULL,
        source_bytes  INTEGER NOT NULL,
        started_at    TEXT    NOT NULL,
        finished_at   TEXT,
        units_done    INTEGER NOT NULL DEFAULT 0,
        variants_done INTEGER NOT NULL DEFAULT 0
      );
    `);
  },
};

export const TM_MIGRATIONS: readonly Migration[] = [v1, v2];
