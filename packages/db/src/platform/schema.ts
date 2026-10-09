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

import { auditEventDdl } from '../audit/events.js';
import { rebuildTable, type Migration } from '../migrate.js';

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

export const PLATFORM_MIGRATIONS: readonly Migration[] = [v1, v2, v3, v4, v5, v6];
