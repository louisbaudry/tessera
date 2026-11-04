/**
 * Portal database schema (portal-v0-spec.md §6).
 *
 * One file (`portal.sqlite`), separate from `platform.sqlite`, the
 * project `.catdb` files, and `.ctm` TMs — this is client-facing
 * business data (orders, files, rates), never translation content.
 */

import type { PortalAuditAction } from '@cat-tool/core';
import type { ClientResourceKind, OrderStatus } from '@cat-tool/portal-core';

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

/**
 * The advisory word count of each source file (portal-v0-spec.md §4, §6;
 * backlog #62). Nullable and additive: `NULL` is "not counted", which is
 * every file uploaded before this version and every one the counter
 * declined. `translation_order.word_count` stays the admin-confirmed
 * figure the price comes from.
 */
const v5: Migration = {
  version: 5,
  description: 'source_file.word_count, an advisory count per upload (backlog #62)',
  up: (db) => {
    db.exec('ALTER TABLE source_file ADD COLUMN word_count INTEGER');
  },
};

/** `audit_event.action` since v6: v4's list plus a client's linked files (backlog #162). */
const V6_AUDIT_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'file.downloaded',
  'file.delivered',
  'order.priced',
  'order.price_baseline',
  'resource.linked',
  'resource.unlinked',
  'resource.exported',
] as const satisfies readonly PortalAuditAction[];

/** `client_resource.kind` since v6: `CLIENT_RESOURCE_KINDS` as of backlog #162. */
const V6_RESOURCE_KINDS = [
  'tm',
  'glossary',
] as const satisfies readonly ClientResourceKind[];

/**
 * A client's own translation memory and glossary (backlog #162,
 * portal-v0-spec.md §9): one `.ctm` and one `.ctg` at most per client, each a
 * file the operator linked to that client by path from the command line
 * (`link-client-resource`), never from a request. A client can only ever
 * take what is linked to them, whole, so another memory cannot leak into
 * their export by a filter that missed a unit. `name` is shown to the client;
 * it was read from the file when linked.
 */
const v6: Migration = {
  version: 6,
  description: "client_resource: a client's linked memory and glossary (backlog #162)",
  up: (db) => {
    db.exec(`
      CREATE TABLE client_resource (
        id        INTEGER PRIMARY KEY,
        client_id INTEGER NOT NULL REFERENCES client(id),
        kind      TEXT NOT NULL CHECK (kind IN (${sqlList(V6_RESOURCE_KINDS)})),
        path      TEXT NOT NULL,
        name      TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        UNIQUE (client_id, kind)
      );
    `);
    rebuildTable(db, 'audit_event', auditEventDdl(V6_AUDIT_ACTIONS));
  },
};

/**
 * Update orders (portal-v0-spec.md §4a; backlog #163): an order may name the
 * delivered order it is a new version of, and each of its uploads may record
 * which earlier file it was compared with and how many of its words are new
 * or changed. All additive and nullable: `NULL` is "not an update" and "not
 * compared", which is every row written before this version. Nothing here
 * prices anything; the admin-confirmed `word_count` still does.
 */
const v7: Migration = {
  version: 7,
  description:
    'translation_order.previous_order_id, source_file.compared_to_file_id and changed_word_count (backlog #163)',
  up: (db) => {
    db.exec(`
      ALTER TABLE translation_order ADD COLUMN previous_order_id INTEGER REFERENCES translation_order(id);
      ALTER TABLE source_file ADD COLUMN compared_to_file_id INTEGER REFERENCES source_file(id);
      ALTER TABLE source_file ADD COLUMN changed_word_count INTEGER;
    `);
  },
};

/**
 * A minimum per file (portal-v0-spec.md §4b; idea #222). `min_words_per_file`
 * is a number of words a file counts as at least when priced, `0` meaning off,
 * so every rate written before this version keeps its meaning; it is a word
 * count rather than a price so it follows the rate. `confirmed_word_count` is
 * the admin's confirmed count of one source file, written only by the pricing
 * write and only for an order a per-file rate applies to; `NULL` is "not
 * confirmed per file", which is every file written before this version.
 * `source_file.word_count` stays the counter's advice and never prices.
 */
const v8: Migration = {
  version: 8,
  description: 'rate.min_words_per_file and source_file.confirmed_word_count (idea #222)',
  up: (db) => {
    db.exec(`
      ALTER TABLE rate ADD COLUMN min_words_per_file INTEGER NOT NULL DEFAULT 0 CHECK (min_words_per_file >= 0);
      ALTER TABLE source_file ADD COLUMN confirmed_word_count INTEGER CHECK (confirmed_word_count >= 0);
    `);
  },
};

/**
 * v9 — the currency the portal's prices are in (issue #327, `portal-v0-spec.md` §9c). One row,
 * written at start from the configured code (`settlePortalCurrency`). A price is a bare number in
 * `translation_order.price` and `rate`, so this row is what says which money it is; it may change
 * only while no order has a price, because an approved price is the client's consent to that amount
 * in that currency. No row is "never started since v9", which `settlePortalCurrency` fills.
 */
const v9: Migration = {
  version: 9,
  description: 'portal_currency: the currency of every price in the file (issue #327)',
  up: (db) => {
    db.exec(`
      CREATE TABLE portal_currency (
        id   INTEGER PRIMARY KEY CHECK (id = 1),
        code TEXT NOT NULL CHECK (length(code) = 3 AND code = upper(code))
      );
    `);
  },
};

/**
 * v10 — a client's own rate for a language pair (issue #331, `portal-v0-spec.md` §3a). The same
 * columns as `rate`, keyed by client and pair; `ratesForClient` puts a row here in place of the
 * pair's default for that client, and a pair with a row here and none in `rate` is offered to that
 * client alone. A table of its own rather than a nullable `client_id` on `rate`, because `rate`'s
 * `UNIQUE (src_lang, tgt_lang)` would have to be rebuilt and a NULL in a unique key is never equal
 * to another, so two defaults for one pair could then exist.
 */
const v10: Migration = {
  version: 10,
  description: "client_rate: a client's own rate for a language pair (issue #331)",
  up: (db) => {
    db.exec(`
      CREATE TABLE client_rate (
        id                 INTEGER PRIMARY KEY,
        client_id          INTEGER NOT NULL REFERENCES client(id),
        src_lang           TEXT NOT NULL,
        tgt_lang           TEXT NOT NULL,
        rate_per_word      REAL NOT NULL CHECK (rate_per_word > 0),
        minimum_price      REAL NOT NULL CHECK (minimum_price >= 0),
        min_words_per_file INTEGER NOT NULL DEFAULT 0 CHECK (min_words_per_file >= 0),
        UNIQUE (client_id, src_lang, tgt_lang)
      );
    `);
  },
};

/**
 * v11 — a client's contacts (issue #318, `planning/sso-spec.md` D6, §2b, phase A): people at a
 * client who will sign in to this tenant's portal with Microsoft or Google, beside the private link.
 * A contact is an address and nothing else (no name, so erasure has only an address to remove),
 * unique within the file in lower case, made by the tenant's admin; `disabled_at` turns one off
 * without losing its row. `client_contact_identity` is the platform's `account_identity` keyed to a
 * contact instead of an account (D2): a sign-in will be matched on `(provider, issuer, subject)`,
 * never on the address. No `tenant_id`: the file is the tenant's (`portal-v0-spec.md` §9a).
 */
const v11: Migration = {
  version: 11,
  description: 'client_contact and client_contact_identity (issue #318)',
  up: (db) => {
    db.exec(`
      CREATE TABLE client_contact (
        id          INTEGER PRIMARY KEY,
        client_id   INTEGER NOT NULL REFERENCES client(id),
        email       TEXT    NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
        created_at  TEXT    NOT NULL,
        disabled_at TEXT
      );
      CREATE INDEX client_contact_client ON client_contact(client_id);

      CREATE TABLE client_contact_identity (
        id            INTEGER PRIMARY KEY,
        contact_id    INTEGER NOT NULL REFERENCES client_contact(id),
        provider      TEXT    NOT NULL CHECK (provider IN ('google', 'microsoft')),
        issuer        TEXT    NOT NULL CHECK (length(issuer) > 0),
        subject       TEXT    NOT NULL CHECK (length(subject) > 0),
        linked_at     TEXT    NOT NULL,
        last_login_at TEXT,
        UNIQUE (provider, issuer, subject)
      );
      CREATE INDEX client_contact_identity_contact ON client_contact_identity(contact_id);
    `);
  },
};

/** `audit_event.action` as of portal v12: v6's list and the two contact sign-in actions. Frozen. */
const V12_AUDIT_ACTIONS = [
  ...V6_AUDIT_ACTIONS,
  'auth.contact_login',
  'auth.contact_login_failed',
] as const satisfies readonly PortalAuditAction[];

/**
 * v12 — a client contact signs in with Microsoft or Google (issue #342, `planning/sso-spec.md` §2b).
 *
 * `client.link_enabled` lets the admin turn a client's private link off (default on, so every existing
 * client keeps it). `client_contact_signin_link` is the one-time link that ties a contact to its first
 * identity, stored only as its hash, one per contact (a table of its own: SQLite cannot add a UNIQUE
 * column to `client_contact`). `sso_attempt` is the portal's own sign-in in flight, as the platform's
 * (no tenant, no account: the file is the tenant's, and a contact is found by its identity).
 * `client_contact_session` is a signed-in contact, the token stored only as its hash. The two new audit
 * actions widen `audit_event`.
 */
const v12: Migration = {
  version: 12,
  description:
    'client.link_enabled, contact sign-in links, sso_attempt and contact sessions (issue #342)',
  up: (db) => {
    db.exec(`
      ALTER TABLE client ADD COLUMN link_enabled INTEGER NOT NULL DEFAULT 1
        CHECK (link_enabled BETWEEN 0 AND 1);

      CREATE TABLE client_contact_signin_link (
        contact_id INTEGER PRIMARY KEY REFERENCES client_contact(id),
        token_hash TEXT    NOT NULL UNIQUE,
        created_at TEXT    NOT NULL,
        expires_at TEXT    NOT NULL
      );

      CREATE TABLE sso_attempt (
        id                 INTEGER PRIMARY KEY,
        state_hash         TEXT    NOT NULL UNIQUE,
        binding_hash       TEXT    NOT NULL,
        nonce              TEXT    NOT NULL,
        code_verifier      TEXT    NOT NULL,
        provider           TEXT    NOT NULL CHECK (provider IN ('google', 'microsoft')),
        purpose            TEXT    NOT NULL CHECK (purpose IN ('contact_link', 'contact_login')),
        created_at         TEXT    NOT NULL,
        expires_at         TEXT    NOT NULL,
        callback_at        TEXT,
        handoff_hash       TEXT    UNIQUE,
        handoff_expires_at TEXT,
        issuer             TEXT,
        subject            TEXT
      );

      CREATE TABLE client_contact_session (
        id         INTEGER PRIMARY KEY,
        contact_id INTEGER NOT NULL REFERENCES client_contact(id),
        token_hash TEXT    NOT NULL UNIQUE,
        created_at TEXT    NOT NULL,
        expires_at TEXT    NOT NULL
      );
      CREATE INDEX client_contact_session_contact ON client_contact_session(contact_id);
    `);
    rebuildTable(db, 'audit_event', auditEventDdl(V12_AUDIT_ACTIONS));
  },
};

const V13_AUDIT_ACTIONS = [
  ...V12_AUDIT_ACTIONS,
  'order.due_set',
] as const satisfies readonly PortalAuditAction[];

/**
 * v13 — the translator's own due date on an order (issue #179, `planning/solo-translator-spec.md`
 * D4). `due_at` is a calendar day (`YYYY-MM-DD`), absent until the admin sets one; setting or
 * clearing it is `order.due_set`, which widens `audit_event`. The index serves the deadline view,
 * which reads open orders by date.
 */
const v13: Migration = {
  version: 13,
  description: 'translation_order.due_at and order.due_set (issue #179)',
  up: (db) => {
    db.exec(`
      ALTER TABLE translation_order ADD COLUMN due_at TEXT
        CHECK (due_at IS NULL OR due_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
      CREATE INDEX translation_order_due ON translation_order(status, due_at);
    `);
    rebuildTable(db, 'audit_event', auditEventDdl(V13_AUDIT_ACTIONS));
  },
};

export const PORTAL_MIGRATIONS: readonly Migration[] = [
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
  v13,
];
