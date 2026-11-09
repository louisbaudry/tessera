/**
 * `admin_user`/`admin_session` repository (portal-v0-spec.md §7).
 *
 * Password hashing and session-token generation/hashing are pure
 * functions in `@cat-tool/portal-core` (`auth.ts`); this module only
 * stores and looks up the results — same split as the rest of the
 * portal (pricing logic in `portal-core`, order rows in `db/portal`).
 *
 * A login records `auth.login` in the session's own transaction
 * (audit-spec.md §2.6; backlog #58); a refused one is `audit.ts`'s.
 */
import type { AuditActor } from '@cat-tool/core';
import { hashSessionToken, SESSION_TTL_MS } from '@cat-tool/portal-core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';

export interface AdminUser {
  readonly id: number;
  readonly email: string;
  readonly passwordHash: string;
  readonly createdAt: string;
}

interface AdminUserRow {
  id: number;
  email: string;
  password_hash: string;
  created_at: string;
}

const userFromRow = (row: AdminUserRow): AdminUser => ({
  id: row.id,
  email: row.email,
  passwordHash: row.password_hash,
  createdAt: row.created_at,
});

export function createAdminUser(
  db: Database.Database,
  email: string,
  passwordHash: string,
): AdminUser {
  const createdAt = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO admin_user (email, password_hash, created_at)
       VALUES (@email, @password_hash, @created_at)`,
    )
    .run({ email, password_hash: passwordHash, created_at: createdAt });
  return { id: info.lastInsertRowid as number, email, passwordHash, createdAt };
}

export function getAdminUserByEmail(
  db: Database.Database,
  email: string,
): AdminUser | null {
  const row = db.prepare('SELECT * FROM admin_user WHERE email = ?').get(email) as
    AdminUserRow | undefined;
  return row ? userFromRow(row) : null;
}

/**
 * Sets a new password for the admin with this address, ends every session it holds and records
 * `admin.password_reset`, in one transaction (issue #364, `portal-v0-spec.md` §7a). It is the
 * operator's recovery, run from the host: nothing here proves who asks, the actor says who ran it.
 *
 * @param passwordHash - an already-hashed password (`hashPassword`); the clear text never reaches `db`.
 * @returns the number of sessions it ended, or `null` when no admin has this address (no row is
 *   written, and the caller must not say whether the address exists beyond that).
 */
export function setAdminPassword(
  db: Database.Database,
  email: string,
  passwordHash: string,
  options: { readonly actor: AuditActor },
): { readonly sessionsEnded: number } | null {
  return db.transaction((): { readonly sessionsEnded: number } | null => {
    const user = getAdminUserByEmail(db, email);
    if (!user) return null;
    db.prepare('UPDATE admin_user SET password_hash = ? WHERE id = ?').run(
      passwordHash,
      user.id,
    );
    const sessionsEnded = db
      .prepare('DELETE FROM admin_session WHERE admin_user_id = ?')
      .run(user.id).changes;
    appendAuditEvent(db, {
      actor: options.actor,
      action: 'admin.password_reset',
      subjectType: 'admin_user',
      subjectId: String(user.id),
      detail: { sessions_ended: sessionsEnded },
    });
    return { sessionsEnded };
  })();
}

export interface AdminSessionOptions {
  /** The admin itself (`admin:<id>`): logging in is its own act. */
  readonly actor: AuditActor;
  readonly now?: Date;
}

/** Stores a new session and records `auth.login` with it. */
export function createAdminSession(
  db: Database.Database,
  adminUserId: number,
  token: string,
  options: AdminSessionOptions,
): { readonly expiresAt: string } {
  const now = options.now ?? new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO admin_session (admin_user_id, token_hash, created_at, expires_at)
       VALUES (@admin_user_id, @token_hash, @created_at, @expires_at)`,
    ).run({
      admin_user_id: adminUserId,
      token_hash: hashSessionToken(token),
      created_at: createdAt,
      expires_at: expiresAt,
    });
    appendAuditEvent(db, {
      actor: options.actor,
      action: 'auth.login',
      subjectType: 'admin_user',
      subjectId: String(adminUserId),
      detail: null,
    });
  })();
  return { expiresAt };
}

/** Null for a missing, expired, or already-revoked session — callers don't need to tell which. */
export function getAdminUserBySessionToken(
  db: Database.Database,
  token: string,
  now: Date = new Date(),
): AdminUser | null {
  const row = db
    .prepare(
      `SELECT admin_user.* FROM admin_session
       JOIN admin_user ON admin_user.id = admin_session.admin_user_id
       WHERE admin_session.token_hash = ? AND admin_session.expires_at > ?`,
    )
    .get(hashSessionToken(token), now.toISOString()) as AdminUserRow | undefined;
  return row ? userFromRow(row) : null;
}

export function deleteAdminSession(db: Database.Database, token: string): void {
  db.prepare('DELETE FROM admin_session WHERE token_hash = ?').run(
    hashSessionToken(token),
  );
}
