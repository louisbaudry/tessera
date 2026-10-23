/**
 * The platform database: server bookkeeping, never translation data.
 *
 * One file (`platform.sqlite`), never `ATTACH`ed to a project or TM,
 * holding just enough to scope file access per owner
 * (v1-spec.md §4.1a, the web-service pivot). v1 seeds exactly one row —
 * this is still a personal tool, reached over the internet rather than
 * installed — but scoping storage by account from the first row is what
 * makes opening registration later additive instead of a migration
 * across every existing user's data.
 */

import type { PlatformAuditAction } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { auditEventDdl } from '../audit/events.js';
import { MigrationError, rebuildTable, type Migration } from '../migrate.js';

/** "CATL" — platform bookkeeping, distinct from project ("CATP") and TM ("CATM"). */
export const PLATFORM_APPLICATION_ID = 0x4341544c;

const v1: Migration = {
  version: 1,
  description: 'initial platform schema (v1-spec.md §4.1a)',
  up: (db) => {
    db.exec(`
      CREATE TABLE account (
        id            INTEGER PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        storage_root  TEXT NOT NULL UNIQUE,
        created_at    TEXT NOT NULL
      );
    `);
  },
};

/**
 * Sessions (backlog #27): the same shape as the portal's `admin_session`
 * — a random bearer token stored only as its SHA-256 hash, with an
 * expiry — because it is the same problem, solved once in
 * `core/auth/credentials.ts`.
 */
const v2: Migration = {
  version: 2,
  description: 'account_session — bearer sessions for the API server (backlog #27)',
  up: (db) => {
    db.exec(`
      CREATE TABLE account_session (
        id          INTEGER PRIMARY KEY,
        account_id  INTEGER NOT NULL REFERENCES account(id),
        token_hash  TEXT NOT NULL UNIQUE,
        created_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL
      );
      CREATE INDEX account_session_account ON account_session(account_id);
    `);
  },
};

/**
 * `audit_event.action` since v3: `PLATFORM_AUDIT_ACTIONS` as of backlog
 * #57. A frozen snapshot, never the live constant (`db/migrate.ts`,
 * backlog #64); a new action is a new migration, never an edit here.
 */
const V3_AUDIT_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'account.created',
  'authorization.granted',
  'authorization.revoked',
  'project.created',
  'project.deleted',
  'file.downloaded',
] as const satisfies readonly PlatformAuditAction[];

/**
 * The audit log (audit-spec.md §2, §2.5; backlog #57): the same table
 * every file that keeps one gets, its `CHECK` admitting only the actions
 * that can happen here. No baseline: nothing before this recorded who
 * created an account, and spec §6 never invents an author.
 */
const v3: Migration = {
  version: 3,
  description: 'audit_event (audit-spec.md §2.5, backlog #57)',
  up: (db) => {
    db.exec(auditEventDdl(V3_AUDIT_ACTIONS));
  },
};

/**
 * `account.role` and `project_authorization` (backlog #45,
 * vendor-spec.md §1 decision 2, §3 implementation note). Both closed sets
 * are frozen literals, never the live constants (`db/migrate.ts`, backlog
 * #64): `ACCOUNT_ROLES` and `PROJECT_SCOPES`, tied to the newest snapshot
 * by `db/check-lists.test.ts`.
 *
 * The role classifies and permits nothing, so every existing account is an
 * `owner` and no data moves. A project is named by its owner and slug (the
 * `ProjectRef` of `audit.ts`), not a row in a registry; a grantee is never
 * the owner, whose access is the path itself.
 */
const v4: Migration = {
  version: 4,
  description: 'account.role and project_authorization (backlog #45)',
  up: (db) => {
    db.exec(`
      ALTER TABLE account ADD COLUMN role TEXT NOT NULL DEFAULT 'owner'
        CHECK (role IN ('owner', 'vendor'));
      CREATE TABLE project_authorization (
        id           INTEGER PRIMARY KEY,
        account_id   INTEGER NOT NULL REFERENCES account(id),
        owner_id     INTEGER NOT NULL REFERENCES account(id),
        project_name TEXT NOT NULL,
        scope        TEXT NOT NULL CHECK (scope IN ('assigned_translator')),
        granted_at   TEXT NOT NULL,
        UNIQUE (account_id, owner_id, project_name),
        CHECK (account_id <> owner_id)
      );
      CREATE INDEX project_authorization_project
        ON project_authorization(owner_id, project_name);
    `);
  },
};

/**
 * `roster_membership` (backlog #52a, vendor-spec.md's #52a note): which owners'
 * rosters an account is on. A derived index of the owners' `.ctv` files, so a
 * vendor can find the owners to read their feed from; the roster, not this
 * table, decides who is a vendor, and it is rebuildable from the rosters.
 */
const v5: Migration = {
  version: 5,
  description: 'roster_membership: which owners’ rosters an account is on (backlog #52a)',
  up: (db) => {
    db.exec(`
      CREATE TABLE roster_membership (
        owner_id   INTEGER NOT NULL REFERENCES account(id),
        account_id INTEGER NOT NULL REFERENCES account(id),
        added_at   TEXT    NOT NULL,
        PRIMARY KEY (owner_id, account_id),
        CHECK (account_id <> owner_id)
      ) WITHOUT ROWID;
      CREATE INDEX roster_membership_account ON roster_membership(account_id);
    `);
  },
};

/**
 * `audit_event.action` since v6: `PLATFORM_AUDIT_ACTIONS` as of backlog #111 (the
 * v3 list and the three invitation events). Frozen, never the live constant.
 */
const V6_AUDIT_ACTIONS = [
  ...V3_AUDIT_ACTIONS,
  'invitation.created',
  'invitation.accepted',
  'invitation.revoked',
] as const satisfies readonly PlatformAuditAction[];

/**
 * An owner's invitation to become a vendor (backlog #111, vendor-spec.md's #111
 * note). The link's token is stored only as its SHA-256 hash, like a session's,
 * so a copy of this file holds no way to set a password. The state is derived
 * from the three timestamps (`invitationStatus`), not stored, so it cannot
 * disagree with them; once a row is accepted or revoked its state columns can
 * never change, which is what makes a link single-use and a withdrawn one
 * final rather than something a route has to remember. The audit log gains the
 * three invitation actions, so `audit_event` is rebuilt (`rebuildTable`).
 */
const v6: Migration = {
  version: 6,
  description: 'vendor_invitation and the invitation audit actions (backlog #111)',
  up: (db) => {
    db.exec(`
      CREATE TABLE vendor_invitation (
        id                  INTEGER PRIMARY KEY,
        owner_id            INTEGER NOT NULL REFERENCES account(id),
        email               TEXT    NOT NULL,
        display_name        TEXT,
        token_hash          TEXT    NOT NULL UNIQUE,
        created_at          TEXT    NOT NULL,
        expires_at          TEXT    NOT NULL,
        accepted_at         TEXT,
        accepted_account_id INTEGER REFERENCES account(id),
        revoked_at          TEXT,
        CHECK ((accepted_at IS NULL) = (accepted_account_id IS NULL)),
        CHECK (accepted_at IS NULL OR revoked_at IS NULL)
      );
      CREATE INDEX vendor_invitation_owner ON vendor_invitation(owner_id, id);
      CREATE INDEX vendor_invitation_email ON vendor_invitation(owner_id, email);

      CREATE TRIGGER vendor_invitation_final
      BEFORE UPDATE ON vendor_invitation
      WHEN (OLD.accepted_at IS NOT NULL OR OLD.revoked_at IS NOT NULL)
        AND (NEW.accepted_at IS NOT OLD.accepted_at
          OR NEW.accepted_account_id IS NOT OLD.accepted_account_id
          OR NEW.revoked_at IS NOT OLD.revoked_at
          OR NEW.token_hash IS NOT OLD.token_hash
          OR NEW.expires_at IS NOT OLD.expires_at)
      BEGIN SELECT RAISE(ABORT, 'a used or withdrawn invitation is final'); END;
    `);
    rebuildTable(db, 'audit_event', auditEventDdl(V6_AUDIT_ACTIONS));
  },
};

/**
 * `audit_event.action` since v7: `PLATFORM_AUDIT_ACTIONS` as of backlog #133 (the
 * v6 list and `client_engine.changed`). Frozen, never the live constant.
 */
const V7_AUDIT_ACTIONS = [
  ...V6_AUDIT_ACTIONS,
  'client_engine.changed',
] as const satisfies readonly PlatformAuditAction[];

/**
 * What a client has agreed about draft engines (backlog #133,
 * `planning/translation-engine-spec.md` D4, D9, D19): one row per engine it
 * consented to, and at most one default engine. A client is the owner's number
 * for it, never checked against `portal.sqlite` (the CAT server must not read
 * that file); a wrong number simply matches no project. **Absence-based**: no
 * row is "no consent" and "default off", so nothing is sent for any existing
 * client and no migration touches their data. Both closed sets are frozen
 * literals, and the audit log gains `client_engine.changed`, so `audit_event`
 * is rebuilt (`rebuildTable`).
 */
const v7: Migration = {
  version: 7,
  description: 'client_engine_consent, client_engine_default (backlog #133, spec D9)',
  up: (db) => {
    db.exec(`
      CREATE TABLE client_engine_consent (
        owner_id     INTEGER NOT NULL REFERENCES account(id),
        client_id    INTEGER NOT NULL CHECK (client_id >= 1),
        engine       TEXT    NOT NULL CHECK (engine IN ('tessera', 'deepl')),
        consented_at TEXT    NOT NULL,
        PRIMARY KEY (owner_id, client_id, engine)
      ) WITHOUT ROWID;
      CREATE TABLE client_engine_default (
        owner_id  INTEGER NOT NULL REFERENCES account(id),
        client_id INTEGER NOT NULL CHECK (client_id >= 1),
        engine    TEXT    NOT NULL CHECK (engine IN ('tessera', 'deepl')),
        PRIMARY KEY (owner_id, client_id)
      ) WITHOUT ROWID;
    `);
    rebuildTable(db, 'audit_event', auditEventDdl(V7_AUDIT_ACTIONS));
  },
};

/**
 * `audit_event.action` since v8: `PLATFORM_AUDIT_ACTIONS` as of backlog #204 (the v7
 * list and the two tenant events). Frozen, never the live constant.
 */
const V8_AUDIT_ACTIONS = [
  ...V7_AUDIT_ACTIONS,
  'tenant.created',
  'tenant.renamed',
] as const satisfies readonly PlatformAuditAction[];

/**
 * `tenant` and `tenant_membership` (backlog #204, `planning/tenant-spec.md` §4, §5):
 * a tenant is one customer LSP, and staff belong to one tenant through a membership.
 * Nothing reads them yet (slice 2, #205, switches the readers), so a file that
 * migrates behaves as before.
 *
 * **Every existing owner becomes the admin of a tenant that takes over its
 * `storage_root`** (D4), so no file moves: the tenant names the directory the
 * account already had. The migration writes no `audit_event` and no real name:
 * nothing recorded who made these and an author is never invented
 * (`audit-spec.md` §6), and the first tenant's name is the operator's to type
 * (`rename-tenant`, D12), never repo content. Each is named `Tenant <id>` until then.
 *
 * `UNIQUE (account_id)` is v1's one tenant per person (D2, O1): a table so that
 * relaxing it later is a constraint change, not a migration of rows. The trigger is
 * D3 in the schema, not in a route: a vendor is never tenant staff, and a vendor
 * reaches a tenant only through its roster. `role` is a frozen literal
 * (`TENANT_ROLES`, tied by `db/check-lists.test.ts`). `audit_event` is rebuilt to
 * admit the two tenant actions.
 */
const v8: Migration = {
  version: 8,
  description: 'tenant, tenant_membership and the tenant audit actions (backlog #204)',
  up: (db) => {
    db.exec(`
      CREATE TABLE tenant (
        id           INTEGER PRIMARY KEY,
        name         TEXT NOT NULL CHECK (length(trim(name)) > 0),
        storage_root TEXT NOT NULL UNIQUE,
        created_at   TEXT NOT NULL
      );
      CREATE TABLE tenant_membership (
        tenant_id  INTEGER NOT NULL REFERENCES tenant(id),
        account_id INTEGER NOT NULL REFERENCES account(id),
        role       TEXT    NOT NULL CHECK (role IN ('admin', 'pm')),
        added_at   TEXT    NOT NULL,
        PRIMARY KEY (tenant_id, account_id),
        UNIQUE (account_id)
      ) WITHOUT ROWID;
      CREATE TRIGGER tenant_membership_staff_only
      BEFORE INSERT ON tenant_membership
      WHEN COALESCE((SELECT role FROM account WHERE id = NEW.account_id), 'owner') <> 'owner'
      BEGIN SELECT RAISE(ABORT, 'a vendor is never tenant staff'); END;

      INSERT INTO tenant (name, storage_root, created_at)
        SELECT 'Tenant', storage_root, created_at FROM account
        WHERE role = 'owner' ORDER BY id;
      UPDATE tenant SET name = 'Tenant ' || id;
      INSERT INTO tenant_membership (tenant_id, account_id, role, added_at)
        SELECT t.id, a.id, 'admin', a.created_at
        FROM account a JOIN tenant t ON t.storage_root = a.storage_root
        WHERE a.role = 'owner';
    `);
    rebuildTable(db, 'audit_event', auditEventDdl(V8_AUDIT_ACTIONS));
  },
};

/**
 * Replaces a leaf table with one keyed on the tenant instead of the owner account
 * (v9). `rebuildTable` cannot do this: it copies the old table's columns by name, and
 * the column being replaced is the point. The copy joins the old `owner_id` through
 * `tenant_membership`, so each row names the tenant its owner was founded as.
 *
 * Refuses, and rolls the whole migration back, when any row names an owner with no
 * tenant: such a row is a grant, roster entry, invitation or consent for an account
 * nothing made a tenant for (a vendor used as an owner), and the choice is to guess a
 * tenant for it or to drop it. Neither is a migration's to make silently. The runner's
 * pre-migration backup is the way back.
 *
 * Only for a table nothing references and that references nothing but `account` and
 * `tenant`; its own indexes and triggers are the caller's, created after the swap.
 */
function rekeyTable(
  db: Database.Database,
  table: string,
  newDdl: string,
  columns: { readonly old: string; readonly new: string },
): void {
  const orphan = db
    .prepare(
      `SELECT COUNT(*) AS n FROM "${table}" t
       LEFT JOIN tenant_membership m ON m.account_id = t.owner_id
       WHERE m.account_id IS NULL`,
    )
    .get() as { n: number };
  if (orphan.n > 0) {
    throw new MigrationError(
      `${table}: ${orphan.n} row(s) name an owner account with no tenant; ` +
        'resolve them before migrating (tenant-spec.md §5)',
    );
  }
  const before = (
    db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }
  ).n;
  const staged = `${table}__rekey`;
  db.exec(newDdl.replace(`CREATE TABLE ${table} `, `CREATE TABLE ${staged} `));
  db.exec(
    `INSERT INTO "${staged}" (${columns.new})
     SELECT ${columns.old} FROM "${table}" t JOIN tenant_membership m ON m.account_id = t.owner_id`,
  );
  const after = (
    db.prepare(`SELECT COUNT(*) AS n FROM "${staged}"`).get() as { n: number }
  ).n;
  if (after !== before) {
    throw new MigrationError(`${table}: re-keying lost rows (${before} → ${after})`);
  }
  db.exec(`DROP TABLE "${table}"`);
  db.exec(`ALTER TABLE "${staged}" RENAME TO "${table}"`);
}

/**
 * The tenant, not the owner account, owns what an owner owned (backlog #205,
 * `planning/tenant-spec.md` §4, D6): the five tables that named an `owner_id` now name
 * a `tenant_id` that references `tenant`. The values change (a tenant's id is not its
 * founder's account id once a vendor sits between two owners), and so do the
 * constraints: a grant's `account_id <> owner_id` goes, since the grantee is an account
 * and the owner a tenant, and a trigger (`project_authorization_not_staff`) takes its
 * place: staff of a tenant already have its projects, so a grant to one is refused.
 *
 * An invitation also records who sent it (`invited_by`), backfilled from the old
 * `owner_id`, which was that one person: the tenant is not a person, and the vendor
 * account an acceptance creates is still attributed to the staff member who vouched
 * for it (audit-spec.md §2.1). Every other column, id and index is as it was, and
 * `vendor_invitation_final` is recreated exactly. No audit event is written (nothing here is a decision), and
 * historical events keep the account ids they were written with: new project events
 * carry a `t<tenant>` prefix so the two can never be mistaken (`projectSubjectId`).
 */
const v9: Migration = {
  version: 9,
  description: 'key ownership on the tenant, not the owner account (backlog #205)',
  up: (db) => {
    rekeyTable(
      db,
      'project_authorization',
      `CREATE TABLE project_authorization (
        id           INTEGER PRIMARY KEY,
        account_id   INTEGER NOT NULL REFERENCES account(id),
        tenant_id    INTEGER NOT NULL REFERENCES tenant(id),
        project_name TEXT NOT NULL,
        scope        TEXT NOT NULL CHECK (scope IN ('assigned_translator')),
        granted_at   TEXT NOT NULL,
        UNIQUE (account_id, tenant_id, project_name)
      )`,
      {
        old: 't.id, t.account_id, m.tenant_id, t.project_name, t.scope, t.granted_at',
        new: 'id, account_id, tenant_id, project_name, scope, granted_at',
      },
    );
    db.exec(`
      CREATE INDEX project_authorization_project
        ON project_authorization(tenant_id, project_name);
      -- What \`CHECK (account_id <> owner_id)\` was, now that the owner is a tenant: staff of a
      -- tenant already have its projects, so a grant to one is a write that means nothing.
      CREATE TRIGGER project_authorization_not_staff
      BEFORE INSERT ON project_authorization
      WHEN EXISTS (SELECT 1 FROM tenant_membership
                   WHERE tenant_id = NEW.tenant_id AND account_id = NEW.account_id)
      BEGIN SELECT RAISE(ABORT, 'staff of a tenant already have its projects'); END;
    `);

    rekeyTable(
      db,
      'roster_membership',
      `CREATE TABLE roster_membership (
        tenant_id  INTEGER NOT NULL REFERENCES tenant(id),
        account_id INTEGER NOT NULL REFERENCES account(id),
        added_at   TEXT    NOT NULL,
        PRIMARY KEY (tenant_id, account_id)
      ) WITHOUT ROWID`,
      {
        old: 'm.tenant_id, t.account_id, t.added_at',
        new: 'tenant_id, account_id, added_at',
      },
    );
    db.exec(`
      CREATE INDEX roster_membership_account ON roster_membership(account_id);
      -- What \`CHECK (account_id <> owner_id)\` was: staff are not on their own tenant's roster.
      CREATE TRIGGER roster_membership_not_staff
      BEFORE INSERT ON roster_membership
      WHEN EXISTS (SELECT 1 FROM tenant_membership
                   WHERE tenant_id = NEW.tenant_id AND account_id = NEW.account_id)
      BEGIN SELECT RAISE(ABORT, 'staff of a tenant are not on its roster'); END;
    `);

    rekeyTable(
      db,
      'vendor_invitation',
      `CREATE TABLE vendor_invitation (
        id                  INTEGER PRIMARY KEY,
        tenant_id           INTEGER NOT NULL REFERENCES tenant(id),
        invited_by          INTEGER NOT NULL REFERENCES account(id),
        email               TEXT    NOT NULL,
        display_name        TEXT,
        token_hash          TEXT    NOT NULL UNIQUE,
        created_at          TEXT    NOT NULL,
        expires_at          TEXT    NOT NULL,
        accepted_at         TEXT,
        accepted_account_id INTEGER REFERENCES account(id),
        revoked_at          TEXT,
        CHECK ((accepted_at IS NULL) = (accepted_account_id IS NULL)),
        CHECK (accepted_at IS NULL OR revoked_at IS NULL)
      )`,
      {
        old: `t.id, m.tenant_id, t.owner_id, t.email, t.display_name, t.token_hash,
              t.created_at, t.expires_at, t.accepted_at, t.accepted_account_id, t.revoked_at`,
        new: `id, tenant_id, invited_by, email, display_name, token_hash,
              created_at, expires_at, accepted_at, accepted_account_id, revoked_at`,
      },
    );
    db.exec(`
      CREATE INDEX vendor_invitation_tenant ON vendor_invitation(tenant_id, id);
      CREATE INDEX vendor_invitation_email ON vendor_invitation(tenant_id, email);
      CREATE TRIGGER vendor_invitation_final
      BEFORE UPDATE ON vendor_invitation
      WHEN (OLD.accepted_at IS NOT NULL OR OLD.revoked_at IS NOT NULL)
        AND (NEW.accepted_at IS NOT OLD.accepted_at
          OR NEW.accepted_account_id IS NOT OLD.accepted_account_id
          OR NEW.revoked_at IS NOT OLD.revoked_at
          OR NEW.token_hash IS NOT OLD.token_hash
          OR NEW.expires_at IS NOT OLD.expires_at)
      BEGIN SELECT RAISE(ABORT, 'a used or withdrawn invitation is final'); END;
    `);

    rekeyTable(
      db,
      'client_engine_consent',
      `CREATE TABLE client_engine_consent (
        tenant_id    INTEGER NOT NULL REFERENCES tenant(id),
        client_id    INTEGER NOT NULL CHECK (client_id >= 1),
        engine       TEXT    NOT NULL CHECK (engine IN ('tessera', 'deepl')),
        consented_at TEXT    NOT NULL,
        PRIMARY KEY (tenant_id, client_id, engine)
      ) WITHOUT ROWID`,
      {
        old: 'm.tenant_id, t.client_id, t.engine, t.consented_at',
        new: 'tenant_id, client_id, engine, consented_at',
      },
    );
    rekeyTable(
      db,
      'client_engine_default',
      `CREATE TABLE client_engine_default (
        tenant_id INTEGER NOT NULL REFERENCES tenant(id),
        client_id INTEGER NOT NULL CHECK (client_id >= 1),
        engine    TEXT    NOT NULL CHECK (engine IN ('tessera', 'deepl')),
        PRIMARY KEY (tenant_id, client_id)
      ) WITHOUT ROWID`,
      {
        old: 'm.tenant_id, t.client_id, t.engine',
        new: 'tenant_id, client_id, engine',
      },
    );
  },
};

export const PLATFORM_MIGRATIONS: readonly Migration[] = [
  v1,
  v2,
  v3,
  v4,
  v5,
  v6,
  v7,
  v8,
  v9,
];
