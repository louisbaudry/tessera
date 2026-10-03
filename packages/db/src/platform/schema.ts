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
import type { Migration } from '../migrate.js';

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

export const PLATFORM_MIGRATIONS: readonly Migration[] = [v1, v2, v3, v4];
