/**
 * Portal database schema (portal-v0-spec.md §6).
 *
 * One file (`portal.sqlite`), separate from `platform.sqlite`, the
 * project `.catdb` files, and `.ctm` TMs — this is client-facing
 * business data (orders, files, rates), never translation content.
 */

import { PORTAL_AUDIT_ACTIONS } from '@cat-tool/core';
import { ORDER_STATUSES } from '@cat-tool/portal-core';

import { auditEventDdl } from '../audit/events.js';
import type { Migration } from '../migrate.js';

/** "CATO" — portal bookkeeping, distinct from platform ("CATL"), project ("CATP"), TM ("CATM"). */
export const PORTAL_APPLICATION_ID = 0x4341544f;

const sqlList = (values: readonly string[]): string =>
  values.map((v) => `'${v}'`).join(', ');

const v1: Migration = {
  version: 1,
  description: 'initial portal schema (portal-v0-spec.md §6)',
  up: (db) => {
    db.exec(`
      CREATE TABLE client (
        id           INTEGER PRIMARY KEY,
        name         TEXT NOT NULL,
        email        TEXT NOT NULL UNIQUE,
        access_token TEXT NOT NULL UNIQUE,
        created_at   TEXT NOT NULL
      );

      CREATE TABLE rate (
        id             INTEGER PRIMARY KEY,
        src_lang       TEXT NOT NULL,
        tgt_lang       TEXT NOT NULL,
        rate_per_word  REAL NOT NULL,
        minimum_price  REAL NOT NULL,
        UNIQUE (src_lang, tgt_lang)
      );

      CREATE TABLE translation_order (
        id           INTEGER PRIMARY KEY,
        client_id    INTEGER NOT NULL REFERENCES client(id),
        src_lang     TEXT NOT NULL,
        notes        TEXT,
        status       TEXT NOT NULL CHECK (status IN (${sqlList(ORDER_STATUSES)})),
        word_count   INTEGER,
        price        REAL,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );

      CREATE TABLE order_target_lang (
        order_id INTEGER NOT NULL REFERENCES translation_order(id),
        tgt_lang TEXT NOT NULL,
        PRIMARY KEY (order_id, tgt_lang)
      );

      CREATE TABLE source_file (
        id            INTEGER PRIMARY KEY,
        order_id      INTEGER NOT NULL REFERENCES translation_order(id),
        filename      TEXT NOT NULL,
        content_type  TEXT NOT NULL,
        byte_size     INTEGER NOT NULL,
        storage_path  TEXT NOT NULL,
        uploaded_at   TEXT NOT NULL
      );

      CREATE TABLE delivered_file (
        id            INTEGER PRIMARY KEY,
        order_id      INTEGER NOT NULL REFERENCES translation_order(id),
        filename      TEXT NOT NULL,
        content_type  TEXT NOT NULL,
        byte_size     INTEGER NOT NULL,
        storage_path  TEXT NOT NULL,
        uploaded_at   TEXT NOT NULL
      );

      CREATE TABLE order_event (
        id          INTEGER PRIMARY KEY,
        order_id    INTEGER NOT NULL REFERENCES translation_order(id),
        from_status TEXT,
        to_status   TEXT NOT NULL,
        note        TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX order_event_order ON order_event(order_id);
    `);
  },
};

const v2: Migration = {
  version: 2,
  description:
    'admin accounts and sessions, replacing PORTAL_ADMIN_TOKEN (portal-v0-spec.md §7)',
  up: (db) => {
    db.exec(`
      CREATE TABLE admin_user (
        id            INTEGER PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );

      CREATE TABLE admin_session (
        id            INTEGER PRIMARY KEY,
        admin_user_id INTEGER NOT NULL REFERENCES admin_user(id),
        token_hash    TEXT NOT NULL UNIQUE,
        created_at    TEXT NOT NULL,
        expires_at    TEXT NOT NULL
      );
      CREATE INDEX admin_session_admin_user ON admin_session(admin_user_id);
    `);
  },
};

/**
 * Auditability (audit-spec.md §2.6, §6; backlog #58). `order_event`
 * stays the record of order transitions (spec decision 7) and gains who
 * made each one: `actor` is `NOT NULL` with no default, so the table is
 * rebuilt rather than `ALTER`ed — a default would let a writer that
 * forgot its actor through silently. Rows from before this migration
 * are `system:migration` with no label: what they were is kept, and no
 * author is invented. The triggers make the log append-only in the
 * schema, `term_decision`'s way; the one UPDATE they let through is
 * erasing a person's label (spec §5), the same exception
 * `audit_event` makes. `audit_event` itself covers what `order_event`
 * does not: admin logins and files entering and leaving.
 */
const v3: Migration = {
  version: 3,
  description:
    'order_event actor + append-only triggers, audit_event (audit-spec.md §2.6, backlog #58)',
  up: (db) => {
    db.exec(`
      CREATE TABLE order_event_v3 (
        id          INTEGER PRIMARY KEY,
        order_id    INTEGER NOT NULL REFERENCES translation_order(id),
        from_status TEXT,
        to_status   TEXT NOT NULL,
        note        TEXT,
        created_at  TEXT NOT NULL,
        actor       TEXT NOT NULL,
        actor_label TEXT
      );
      INSERT INTO order_event_v3
        (id, order_id, from_status, to_status, note, created_at, actor, actor_label)
      SELECT id, order_id, from_status, to_status, note, created_at,
             'system:migration', NULL
      FROM order_event;
      DROP TABLE order_event;
      ALTER TABLE order_event_v3 RENAME TO order_event;
      CREATE INDEX order_event_order ON order_event(order_id);

      CREATE TRIGGER order_event_no_delete BEFORE DELETE ON order_event
      BEGIN SELECT RAISE(ABORT, 'order_event is append-only'); END;

      CREATE TRIGGER order_event_no_update BEFORE UPDATE ON order_event
      WHEN NEW.id IS NOT OLD.id OR NEW.order_id IS NOT OLD.order_id
        OR NEW.from_status IS NOT OLD.from_status OR NEW.to_status IS NOT OLD.to_status
        OR NEW.note IS NOT OLD.note OR NEW.created_at IS NOT OLD.created_at
        OR NEW.actor IS NOT OLD.actor
        OR NEW.actor_label IS NOT '[erased]'
      BEGIN SELECT RAISE(ABORT, 'order_event is append-only'); END;
    `);
    db.exec(auditEventDdl(PORTAL_AUDIT_ACTIONS));
  },
};

export const PORTAL_MIGRATIONS: readonly Migration[] = [v1, v2, v3];
