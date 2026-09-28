/**
 * Portal database schema (portal-v0-spec.md §6).
 *
 * One file (`portal.sqlite`), separate from `platform.sqlite`, the
 * project `.catdb` files, and `.ctm` TMs — this is client-facing
 * business data (orders, files, rates), never translation content.
 */

import type { PortalAuditAction } from '@cat-tool/core';
import type { OrderStatus } from '@cat-tool/portal-core';

import { appendAuditEvent, auditEventDdl } from '../audit/events.js';
import { rebuildTable, sqlList, type Migration } from '../migrate.js';

/** "CATO" — portal bookkeeping, distinct from platform ("CATL"), project ("CATP"), TM ("CATM"). */
export const PORTAL_APPLICATION_ID = 0x4341544f;

/*
 * Frozen snapshots, never the live constants (`db/migrate.ts`, backlog
 * #64): each is exactly the list its migration created. A new member
 * is a new migration, never an edit here.
 */

/** `translation_order.status` since v1: `ORDER_STATUSES` as of portal v0. */
const V1_ORDER_STATUSES = [
  'submitted',
  'approved',
  'in_progress',
  'delivered',
  'cancelled',
] as const satisfies readonly OrderStatus[];

/** `audit_event.action` since v3: `PORTAL_AUDIT_ACTIONS` as of backlog #58. */
const V3_AUDIT_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'file.downloaded',
  'file.delivered',
] as const satisfies readonly PortalAuditAction[];

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
        status       TEXT NOT NULL CHECK (status IN (${sqlList(V1_ORDER_STATUSES)})),
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
    db.exec(auditEventDdl(V3_AUDIT_ACTIONS));
  },
};

/** `audit_event.action` since v4: v3's list plus pricing (backlog #63). */
const V4_AUDIT_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'file.downloaded',
  'file.delivered',
  'order.priced',
  'order.price_baseline',
] as const satisfies readonly PortalAuditAction[];

/** The actor of everything the migration itself writes (audit-spec.md §6). */
const MIGRATION_ACTOR = {
  actor: { kind: 'system', name: 'migration' },
  label: null,
} as const;

/**
 * Pricing is audited (audit-spec.md §2.6, §6; backlog #63). `audit_event`
 * is rebuilt with `order.priced` and `order.price_baseline` admitted,
 * keeping every row, id and chain hash: `rebuildTable` renames first, so
 * `batch_id`'s self-reference survives. Then each order already priced
 * gets one `order.price_baseline`: what its price was when recording
 * began, never an invented author.
 */
const v4: Migration = {
  version: 4,
  description:
    'audit_event admits order.priced; a price baseline per priced order (backlog #63)',
  up: (db) => {
    rebuildTable(db, 'audit_event', auditEventDdl(V4_AUDIT_ACTIONS));
    const priced = db
      .prepare(
        `SELECT id, word_count, price FROM translation_order
         WHERE price IS NOT NULL AND word_count IS NOT NULL ORDER BY id`,
      )
      .all() as Array<{ id: number; word_count: number; price: number }>;
    for (const order of priced) {
      appendAuditEvent(db, {
        actor: MIGRATION_ACTOR,
        action: 'order.price_baseline',
        subjectType: 'translation_order',
        subjectId: String(order.id),
        detail: { word_count: order.word_count, price: order.price },
      });
    }
  },
};

export const PORTAL_MIGRATIONS: readonly Migration[] = [v1, v2, v3, v4];
