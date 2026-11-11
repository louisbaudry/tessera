/**
 * Connector tokens (backlog #378, `planning/chat-connector-spec.md` D4): the credential a chat
 * assistant presents to the connector's endpoint. A token is its own kind of credential, not a
 * session: it is looked up in its own table, so it opens the connector and nothing else, and a
 * session token opens everything else and not the connector.
 *
 * - **Staff only.** A token is made for the tenant the person is staff of at that moment; a
 *   vendor has none and is refused (spec D2).
 * - **It follows the membership.** `resolveConnectorToken` answers only while the person is still
 *   staff of the token's tenant, so removing someone ends their tokens without a second write.
 * - **Stored as a hash**, with the session primitives of `core/auth/credentials.ts`; the token is
 *   shown once by whoever calls `createConnectorToken` and never read back.
 * - **Logged.** Creating and revoking are `connector.token_created` / `connector.token_revoked`
 *   in the tenant's slice of the log, with the token's id and never its label.
 */

import { hashSessionToken, type AuditActor } from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { type Account, getAccountById } from './accounts.js';
import { appendPlatformEvent } from './audit-write.js';
import { getTenantForAccount, type TenantMembership } from './tenants.js';

/** How long a connector token lives: 90 days, then the person makes another. */
export const CONNECTOR_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** How many live tokens one person may hold; the next is refused until one is revoked or ends. */
export const MAX_CONNECTOR_TOKENS = 10;

/** The longest label, in characters; the table's CHECK holds the same bound. */
export const MAX_CONNECTOR_LABEL = 80;

/** What a person sees of one of their tokens: never the token or its hash. */
export interface ConnectorToken {
  readonly id: number;
  readonly label: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export type ConnectorTokenProblem = 'not_staff' | 'bad_label' | 'too_many';

/** Why a token was not made. The `problem` is what a route turns into a status. */
export class ConnectorTokenError extends Error {
  constructor(readonly problem: ConnectorTokenProblem) {
    super(
      problem === 'not_staff'
        ? 'only a member of an organisation can connect a chat assistant'
        : problem === 'bad_label'
          ? `a label of 1 to ${MAX_CONNECTOR_LABEL} characters is required`
          : `no more than ${MAX_CONNECTOR_TOKENS} connections at a time; disconnect one first`,
    );
    this.name = 'ConnectorTokenError';
  }
}

interface TokenRow {
  id: number;
  label: string;
  created_at: string;
  expires_at: string;
}

const fromRow = (row: TokenRow): ConnectorToken => ({
  id: row.id,
  label: row.label,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

// A control character in a label would break the one line a list shows it on.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** The label as stored (trimmed), or null when it cannot be one. */
function cleanLabel(label: unknown): string | null {
  if (typeof label !== 'string') return null;
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CONNECTOR_LABEL) return null;
  return CONTROL.test(trimmed) ? null : trimmed;
}

const LIVE = 'revoked_at IS NULL AND expires_at > @now';
// A token a person made by hand, as against a connection's hourly access token (backlog #381).
const BY_HAND = 'connection_id IS NULL';

/**
 * Stores a new connector token for `accountId` and records `connector.token_created`, in one
 * transaction.
 *
 * @param options.token - the token itself (`generateSessionToken`); only its hash is stored.
 * @param options.label - what the person calls this connection; trimmed, 1 to 80 characters.
 * @throws ConnectorTokenError when the account is staff of no tenant, the label is unusable, or
 *   the account already holds `MAX_CONNECTOR_TOKENS` live tokens.
 */
export function createConnectorToken(
  db: Database.Database,
  options: {
    readonly accountId: number;
    readonly token: string;
    readonly label: unknown;
    readonly actor: AuditActor;
    readonly now?: Date;
  },
): ConnectorToken {
  const now = options.now ?? new Date();
  const label = cleanLabel(options.label);
  if (label === null) throw new ConnectorTokenError('bad_label');
  return db.transaction((): ConnectorToken => {
    const membership = getTenantForAccount(db, options.accountId);
    if (!membership) throw new ConnectorTokenError('not_staff');
    const held = db
      .prepare(
        `SELECT COUNT(*) AS n FROM connector_token
          WHERE account_id = @a AND ${BY_HAND} AND ${LIVE}`,
      )
      .get({ a: options.accountId, now: now.toISOString() }) as { n: number };
    if (held.n >= MAX_CONNECTOR_TOKENS) throw new ConnectorTokenError('too_many');
    const row = {
      account_id: options.accountId,
      tenant_id: membership.tenant.id,
      token_hash: hashSessionToken(options.token),
      label,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + CONNECTOR_TOKEN_TTL_MS).toISOString(),
    };
    const id = db
      .prepare(
        `INSERT INTO connector_token (account_id, tenant_id, token_hash, label, created_at, expires_at)
         VALUES (@account_id, @tenant_id, @token_hash, @label, @created_at, @expires_at)`,
      )
      .run(row).lastInsertRowid as number;
    appendPlatformEvent(db, {
      actor: options.actor,
      action: 'connector.token_created',
      tenantId: membership.tenant.id,
      subjectType: 'account',
      subjectId: String(options.accountId),
      detail: { token_id: id, expires_at: row.expires_at },
    });
    return { id, label, createdAt: row.created_at, expiresAt: row.expires_at };
  })();
}

/**
 * The account's live hand-made tokens (not revoked, not ended), oldest first. A connection's
 * access tokens are not listed: the person sees the connection (`listConnections`).
 */
export function listConnectorTokens(
  db: Database.Database,
  accountId: number,
  now: Date = new Date(),
): ConnectorToken[] {
  const rows = db
    .prepare(
      `SELECT id, label, created_at, expires_at FROM connector_token
        WHERE account_id = @a AND ${BY_HAND} AND ${LIVE} ORDER BY id`,
    )
    .all({ a: accountId, now: now.toISOString() }) as TokenRow[];
  return rows.map(fromRow);
}

/**
 * Revokes one of the account's own tokens and records `connector.token_revoked`.
 *
 * @returns false when the account has no live token with this id: someone else's, an unknown
 *   one and one already revoked are the same answer, so a route can make them one 404.
 */
export function revokeConnectorToken(
  db: Database.Database,
  options: {
    readonly accountId: number;
    readonly id: number;
    readonly actor: AuditActor;
    readonly now?: Date;
  },
): boolean {
  const now = options.now ?? new Date();
  return db.transaction((): boolean => {
    const row = db
      .prepare(
        `SELECT tenant_id FROM connector_token
          WHERE id = @id AND account_id = @a AND ${BY_HAND} AND revoked_at IS NULL`,
      )
      .get({ id: options.id, a: options.accountId }) as { tenant_id: number } | undefined;
    if (!row) return false;
    db.prepare('UPDATE connector_token SET revoked_at = ? WHERE id = ?').run(
      now.toISOString(),
      options.id,
    );
    appendPlatformEvent(db, {
      actor: options.actor,
      action: 'connector.token_revoked',
      tenantId: row.tenant_id,
      subjectType: 'account',
      subjectId: String(options.accountId),
      detail: { token_id: options.id },
    });
    return true;
  })();
}

/**
 * Who a connector token speaks for, or null. It answers only for a live token whose person is
 * **still staff of the tenant the token was made for**: someone removed, or moved to another
 * tenant, holds a token that opens nothing.
 */
export function resolveConnectorToken(
  db: Database.Database,
  token: string,
  now: Date = new Date(),
): { readonly account: Account; readonly membership: TenantMembership } | null {
  const row = db
    .prepare(
      `SELECT account_id, tenant_id FROM connector_token
        WHERE token_hash = @hash AND ${LIVE}`,
    )
    .get({ hash: hashSessionToken(token), now: now.toISOString() }) as
    { account_id: number; tenant_id: number } | undefined;
  if (!row) return null;
  const membership = getTenantForAccount(db, row.account_id);
  if (!membership || membership.tenant.id !== row.tenant_id) return null;
  const account = getAccountById(db, row.account_id);
  return account ? { account, membership } : null;
}
