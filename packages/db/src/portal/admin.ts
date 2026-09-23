/**
 * `admin_user`/`admin_session` repository (portal-v0-spec.md §7).
 *
 * Password hashing and session-token generation/hashing are pure
 * functions in `@cat-tool/portal-core` (`auth.ts`); this module only
 * stores and looks up the results — same split as the rest of the
 * portal (pricing logic in `portal-core`, order rows in `db/portal`).
 */
import { hashSessionToken, SESSION_TTL_MS } from '@cat-tool/portal-core';
import type Database from 'better-sqlite3';

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

export function createAdminSession(
  db: Database.Database,
  adminUserId: number,
  token: string,
  now: Date = new Date(),
): { readonly expiresAt: string } {
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO admin_session (admin_user_id, token_hash, created_at, expires_at)
     VALUES (@admin_user_id, @token_hash, @created_at, @expires_at)`,
  ).run({
    admin_user_id: adminUserId,
    token_hash: hashSessionToken(token),
    created_at: createdAt,
    expires_at: expiresAt,
  });
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
