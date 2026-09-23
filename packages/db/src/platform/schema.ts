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

export const PLATFORM_MIGRATIONS: readonly Migration[] = [v1, v2];
