/**
 * `.ctg` glossary schema (`smart-glossary-spec.md` §3; backlog #39).
 *
 * Deliberately the `.ctm` shape with the vocabulary changed — identity
 * (`term`) vs. per-language variant (`term_variant`), per-variant `rev`,
 * tombstones, a history table for merge parity — so every lesson that
 * format already paid for carries over. What is new is `term_decision`:
 * an append-only log of what was offered, what was chosen, by whom and
 * where. The current preferred rendering is *derived* from that log
 * (`terms.ts`, `preferredVariant`), never stored, so it cannot drift
 * from its own justification.
 */

import { DECISION_KINDS, NORMALIZER_VERSION } from '@cat-tool/core';

import type { Migration } from '../migrate.js';

/** "CATG" — distinct from `.ctm`'s "CATM", the project's "CATP", the portal's "CATO". */
export const GLOSSARY_APPLICATION_ID = 0x43415447;

const sqlList = (values: readonly string[]): string =>
  values.map((v) => `'${v}'`).join(', ');

const v1: Migration = {
  version: 1,
  description: 'initial glossary schema (smart-glossary-spec.md §3)',
  up: (db) => {
    db.exec(`
      CREATE TABLE glossary (
        id                 INTEGER PRIMARY KEY CHECK (id = 1),
        uuid               TEXT    NOT NULL UNIQUE,
        name               TEXT    NOT NULL,
        client             TEXT,
        langs              TEXT    NOT NULL,
        created_at         TEXT    NOT NULL,
        format_version     INTEGER NOT NULL,
        generator          TEXT    NOT NULL,
        normalizer_version INTEGER NOT NULL,
        read_only          INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE term (
        id         INTEGER PRIMARY KEY,
        uuid       TEXT    NOT NULL UNIQUE,
        rev        INTEGER NOT NULL DEFAULT 1,
        created_at TEXT    NOT NULL,
        updated_at TEXT    NOT NULL,
        deleted    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX term_updated ON term(updated_at);

      CREATE TABLE term_variant (
        id         INTEGER PRIMARY KEY,
        term_id    INTEGER NOT NULL REFERENCES term(id) ON DELETE CASCADE,
        lang       TEXT    NOT NULL,
        rev        INTEGER NOT NULL DEFAULT 1,
        text       TEXT    NOT NULL,
        plain      TEXT    NOT NULL,
        note       TEXT,
        forbidden  INTEGER NOT NULL DEFAULT 0,
        created_at TEXT    NOT NULL,
        updated_at TEXT    NOT NULL,
        updated_by TEXT,
        UNIQUE (term_id, lang, plain)
      );
      CREATE INDEX term_variant_lookup ON term_variant(lang, plain);

      CREATE TABLE term_variant_history (
        term_variant_id INTEGER NOT NULL REFERENCES term_variant(id) ON DELETE CASCADE,
        rev             INTEGER NOT NULL,
        text            TEXT    NOT NULL,
        note            TEXT,
        forbidden       INTEGER NOT NULL,
        changed_at      TEXT    NOT NULL,
        changed_by      TEXT,
        PRIMARY KEY (term_variant_id, rev)
      ) WITHOUT ROWID;

      -- No ON DELETE CASCADE: a term with decisions cannot be hard-deleted,
      -- only tombstoned. Erasing a term must not erase why it was chosen.
      CREATE TABLE term_decision (
        id             INTEGER PRIMARY KEY,
        term_id        INTEGER NOT NULL REFERENCES term(id),
        lang           TEXT    NOT NULL,
        chosen         TEXT    NOT NULL,
        rejected       TEXT    NOT NULL,
        kind           TEXT    NOT NULL CHECK (kind IN (${sqlList(DECISION_KINDS)})),
        source_project TEXT,
        source_segment INTEGER,
        decided_by     TEXT,
        decided_at     TEXT    NOT NULL
      );
      CREATE INDEX term_decision_term ON term_decision(term_id, lang, decided_at);

      -- Append-only, enforced in the file itself rather than by
      -- convention in the repository: a decision log that any caller
      -- with the connection could quietly rewrite is not a log.
      CREATE TRIGGER term_decision_no_update BEFORE UPDATE ON term_decision BEGIN
        SELECT RAISE(ABORT, 'term_decision is append-only');
      END;
      CREATE TRIGGER term_decision_no_delete BEFORE DELETE ON term_decision BEGIN
        SELECT RAISE(ABORT, 'term_decision is append-only');
      END;
    `);
  },
};

export const GLOSSARY_MIGRATIONS: readonly Migration[] = [v1];

/** Imported from `core`, never redeclared — the `primarySubtag` lesson (backlog #15e). */
export { NORMALIZER_VERSION };
