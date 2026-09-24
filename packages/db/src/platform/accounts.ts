/**
 * `account`/`account_session` repository (v1-spec.md §4.1a; backlog #27).
 *
 * The same split as the portal's `admin.ts`: hashing and token
 * generation are pure functions in `@cat-tool/core`
 * (`auth/credentials.ts`); this module only stores and looks up the
 * results. What is different is the one column the portal's admin does
 * not have — `storage_root`, the directory under the server's volume
 * that every file this account owns lives beneath. It is minted here,
 * never chosen by a caller, so it is always the shape the server's
 * path builder trusts.
 *
 * Every write here records its `audit_event` in the same transaction
 * (audit-spec.md §2.5; backlog #57), with a required actor.
 */

import { randomBytes } from 'node:crypto';

import { hashSessionToken, SESSION_TTL_MS, type AuditActor } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';

export interface Account {
  readonly id: number;
  readonly email: string;
  readonly passwordHash: string;
  /** Relative to the server's storage volume, e.g. `u/3f9a2c…` (§4.1a). */
  readonly storageRoot: string;
  readonly createdAt: string;
}

interface AccountRow {
  id: number;
  email: string;
  password_hash: string;
  storage_root: string;
  created_at: string;
}

const fromRow = (row: AccountRow): Account => ({
  id: row.id,
  email: row.email,
  passwordHash: row.password_hash,
  storageRoot: row.storage_root,
  createdAt: row.created_at,
});

export interface CreateAccountOptions {
  readonly email: string;
  /** From `hashPassword` — never a raw password. */
  readonly passwordHash: string;
  /** Who created it — required (audit-spec.md decision 3). */
  readonly actor: AuditActor;
}

/** `u/` plus 96 random bits, hex: unguessable, and nothing a path builder needs to escape. */
function newStorageRoot(): string {
  return `u/${randomBytes(12).toString('hex')}`;
}

export function createAccount(
  db: Database.Database,
  options: CreateAccountOptions,
): Account {
  const createdAt = new Date().toISOString();
  const storageRoot = newStorageRoot();
  return db.transaction((): Account => {
    const info = db
      .prepare(
        `INSERT INTO account (email, password_hash, storage_root, created_at)
         VALUES (@email, @password_hash, @storage_root, @created_at)`,
      )
      .run({
        email: options.email,
        password_hash: options.passwordHash,
        storage_root: storageRoot,
        created_at: createdAt,
      });
    const id = info.lastInsertRowid as number;
    // The email stays in `account`, never in the hashed detail (spec §2.5).
    appendAuditEvent(db, {
      actor: options.actor,
      action: 'account.created',
      subjectType: 'account',
      subjectId: String(id),
      detail: null,
    });
    return {
      id,
      email: options.email,
      passwordHash: options.passwordHash,
      storageRoot,
      createdAt,
    };
  })();
}

export function getAccountByEmail(db: Database.Database, email: string): Account | null {
  const row = db.prepare('SELECT * FROM account WHERE email = ?').get(email) as
    AccountRow | undefined;
  return row ? fromRow(row) : null;
}

export function listAccounts(db: Database.Database): Account[] {
  return (db.prepare('SELECT * FROM account ORDER BY id').all() as AccountRow[]).map(
    fromRow,
  );
}

export interface SessionWriteOptions {
  /** The account itself: logging in and out are its own acts (spec §2.5). */
  readonly actor: AuditActor;
  readonly now?: Date;
}

/** Stores a new session and records `auth.login` with it. */
export function createAccountSession(
  db: Database.Database,
  accountId: number,
  token: string,
  options: SessionWriteOptions,
): { readonly expiresAt: string } {
  const now = options.now ?? new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO account_session (account_id, token_hash, created_at, expires_at)
       VALUES (@account_id, @token_hash, @created_at, @expires_at)`,
    ).run({
      account_id: accountId,
      token_hash: hashSessionToken(token),
      created_at: createdAt,
      expires_at: expiresAt,
    });
    appendAuditEvent(db, {
      actor: options.actor,
      action: 'auth.login',
      subjectType: 'account',
      subjectId: String(accountId),
      detail: null,
    });
  })();
  return { expiresAt };
}

/** Null for a missing, expired, or revoked session — callers don't need to tell which. */
export function getAccountBySessionToken(
  db: Database.Database,
  token: string,
  now: Date = new Date(),
): Account | null {
  const row = db
    .prepare(
      `SELECT account.* FROM account_session
       JOIN account ON account.id = account_session.account_id
       WHERE account_session.token_hash = ? AND account_session.expires_at > ?`,
    )
    .get(hashSessionToken(token), now.toISOString()) as AccountRow | undefined;
  return row ? fromRow(row) : null;
}

/**
 * Revokes a session and records `auth.logout`. A token with no session
 * behind it revokes nothing and records nothing: `false`.
 */
export function deleteAccountSession(
  db: Database.Database,
  token: string,
  options: Pick<SessionWriteOptions, 'actor'>,
): boolean {
  return db.transaction((): boolean => {
    const row = db
      .prepare('SELECT account_id FROM account_session WHERE token_hash = ?')
      .get(hashSessionToken(token)) as { account_id: number } | undefined;
    if (!row) return false;
    db.prepare('DELETE FROM account_session WHERE token_hash = ?').run(
      hashSessionToken(token),
    );
    appendAuditEvent(db, {
      actor: options.actor,
      action: 'auth.logout',
      subjectType: 'account',
      subjectId: String(row.account_id),
      detail: null,
    });
    return true;
  })();
}
