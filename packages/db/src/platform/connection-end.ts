/**
 * Ending a chat-host connection (backlog #381): the one write that does it, kept in a module of
 * its own because both the sign-in store (`connector-oauth.ts`) and the password reset
 * (`accounts.ts`) need it, and the first already imports the second.
 */

import type { AuditActor } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { appendPlatformEvent } from './audit-write.js';

/** Why a connection ended, as `connector.disconnected` records it. */
export type DisconnectReason = 'person' | 'replaced' | 'reuse' | 'password_reset';

/**
 * Ends a connection, revokes its access tokens and records `connector.disconnected`. A no-op
 * for one already ended. Runs inside the caller's transaction.
 */
export function endConnection(
  db: Database.Database,
  connectionId: number,
  reason: DisconnectReason,
  actor: AuditActor,
  now: Date,
): void {
  const row = db
    .prepare(
      'SELECT account_id, tenant_id FROM oauth_connection WHERE id = ? AND revoked_at IS NULL',
    )
    .get(connectionId) as { account_id: number; tenant_id: number } | undefined;
  if (!row) return;
  const at = now.toISOString();
  db.prepare('UPDATE oauth_connection SET revoked_at = ? WHERE id = ?').run(
    at,
    connectionId,
  );
  db.prepare(
    'UPDATE connector_token SET revoked_at = ? WHERE connection_id = ? AND revoked_at IS NULL',
  ).run(at, connectionId);
  appendPlatformEvent(db, {
    actor,
    action: 'connector.disconnected',
    tenantId: row.tenant_id,
    subjectType: 'account',
    subjectId: String(row.account_id),
    detail: { connection_id: connectionId, reason },
  });
}

/**
 * Ends every connection of an account and spends its pending authorization codes: what a
 * password reset does, with the sessions and the hand-made tokens. Runs inside the caller's transaction.
 *
 * @returns how many connections it ended.
 */
export function endConnectionsOfAccount(
  db: Database.Database,
  accountId: number,
  actor: AuditActor,
  now: Date = new Date(),
): number {
  const rows = db
    .prepare(
      'SELECT id FROM oauth_connection WHERE account_id = ? AND revoked_at IS NULL',
    )
    .all(accountId) as { id: number }[];
  for (const row of rows) endConnection(db, row.id, 'password_reset', actor, now);
  // A code that was waiting to be exchanged would make a new connection after the recovery, so
  // it is spent here: whoever consented may no longer be who holds the account.
  db.prepare(
    'UPDATE oauth_code SET used_at = ? WHERE account_id = ? AND used_at IS NULL',
  ).run(now.toISOString(), accountId);
  return rows.length;
}
