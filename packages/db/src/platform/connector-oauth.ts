/**
 * Sign-in from a chat host (backlog #381, `planning/chat-connector-spec.md` §6b): the stores
 * behind the connector's OAuth 2.1 flow. A client registers itself, a signed-in person consents
 * on a page of the application, the client exchanges a one-time code (with PKCE) for an access
 * token and a refresh token, and refreshes from then on. The pure rules (redirect addresses,
 * PKCE) are `core/auth/oauth.ts`; the routes are `server/src/connector-oauth.ts`.
 *
 * What holds here, whatever a route does:
 *
 * - **An access token is a connector token** (`connector-tokens.ts`), an hour long, tied to its
 *   connection. So the endpoint's gate keeps one lookup, and a connection that ended opens
 *   nothing at once.
 * - **A connection follows the membership**, as a hand-made token does: exchanging and
 *   refreshing answer only while the person is still staff of the connection's tenant.
 * - **A code and a refresh token are single-use, stored as hashes.** A failed exchange spends
 *   the code. A spent code or refresh token presented again ends the connection: one of the two
 *   holders is not the client.
 * - **A client is a stranger's claim.** Its name and addresses are never logged, registration
 *   is capped by the hour, and a client nobody ever connected is deleted after thirty days.
 * - **Every refusal is `null`**, so a route gives one answer (`invalid_grant`) and says nothing
 *   about why.
 */

import {
  hashSessionToken,
  MAX_REDIRECT_URIS,
  pkceMatches,
  redirectUriProblem,
  type AuditActor,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';

import { getAccountById } from './accounts.js';
import { appendPlatformEvent } from './audit-write.js';
import { endConnection } from './connection-end.js';
import { ConnectorTokenError } from './connector-tokens.js';
import { getTenantForAccount } from './tenants.js';

/** How long an authorization code lives. The exchange follows the redirect within seconds. */
export const OAUTH_CODE_TTL_MS = 2 * 60 * 1000;

/** How long an access token lives; the client refreshes after that. */
export const OAUTH_ACCESS_TTL_MS = 60 * 60 * 1000;

/** How long a refresh token lives. Each refresh issues a new one, so a connection in use goes on. */
export const OAUTH_REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** How many clients may register in one hour, over the whole server; the next is refused. */
export const MAX_CLIENT_REGISTRATIONS_PER_HOUR = 30;

/** A client nobody connected is deleted this long after it registered. */
export const UNUSED_CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How many live connections one person may hold; a further one ends the oldest. */
export const MAX_CONNECTIONS = 10;

/** The longest client name, in characters; the table's CHECK holds the same bound. */
export const MAX_CLIENT_NAME = 80;

const HOUR_MS = 60 * 60 * 1000;

/** A registered client, as the consent page and the flow read it. */
export interface OauthClient {
  /** The row id: what a log names. */
  readonly id: number;
  /** The public identifier the client presents. */
  readonly clientId: string;
  /** The tenant whose host registered it; null on a server with no base domain. */
  readonly tenantId: number | null;
  /** What the client calls itself: a stranger's claim, shown as one. */
  readonly name: string;
  readonly redirectUris: readonly string[];
}

export type OauthClientProblem = 'bad_redirect' | 'bad_name' | 'too_many';

/** Why a client was not registered; `detail` is safe to send back. */
export class OauthClientError extends Error {
  constructor(
    readonly problem: OauthClientProblem,
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'OauthClientError';
  }
}

/** What a person sees of one of their connections. */
export interface Connection {
  readonly id: number;
  /** The client's own name for itself. */
  readonly name: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
}

/** What a successful exchange or refresh hands the route. */
export interface IssuedTokens {
  /** Seconds until the access token ends. */
  readonly expiresIn: number;
}

/** The actor of an ending nobody asked for: a spent credential presented again. */
const SYSTEM_ACTOR: AuditActor = {
  actor: { kind: 'system', name: 'connector-oauth' },
  label: null,
};

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

interface ClientRow {
  id: number;
  client_id: string;
  tenant_id: number | null;
  name: string;
  redirect_uris: string;
}

const clientFromRow = (row: ClientRow): OauthClient => ({
  id: row.id,
  clientId: row.client_id,
  tenantId: row.tenant_id,
  name: row.name,
  redirectUris: JSON.parse(row.redirect_uris) as string[],
});

/** Deletes clients that registered long ago and that nobody ever connected, with their codes. */
function purgeUnusedClients(db: Database.Database, now: Date): void {
  const before = new Date(now.getTime() - UNUSED_CLIENT_TTL_MS).toISOString();
  const unused = `SELECT id FROM oauth_client c WHERE c.created_at < @before
                   AND NOT EXISTS (SELECT 1 FROM oauth_connection g WHERE g.client = c.id)`;
  db.prepare(`DELETE FROM oauth_code WHERE client IN (${unused})`).run({ before });
  db.prepare(`DELETE FROM oauth_client WHERE id IN (${unused})`).run({ before });
}

/**
 * Registers a client (RFC 7591, a public client: no secret). Old clients nobody connected are
 * deleted first, in the same transaction.
 *
 * @param options.clientId - the identifier to give it (`generateSessionToken`).
 * @param options.name - what the client calls itself; trimmed, 1 to 80 characters, defaulted by
 *   the caller when the request had none.
 * @param options.redirectUris - 1 to `MAX_REDIRECT_URIS` addresses, each passing
 *   `redirectUriProblem`.
 * @param options.tenantId - the tenant of the host the request came to, or null.
 * @throws OauthClientError for an unusable name or address, or when
 *   `MAX_CLIENT_REGISTRATIONS_PER_HOUR` clients registered in the last hour.
 */
export function registerOauthClient(
  db: Database.Database,
  options: {
    readonly clientId: string;
    readonly name: unknown;
    readonly redirectUris: unknown;
    readonly tenantId: number | null;
    readonly now?: Date;
  },
): OauthClient {
  const now = options.now ?? new Date();
  const name = typeof options.name === 'string' ? options.name.trim() : '';
  if (name.length === 0 || name.length > MAX_CLIENT_NAME || CONTROL.test(name)) {
    throw new OauthClientError(
      'bad_name',
      `client_name must be 1 to ${MAX_CLIENT_NAME} characters`,
    );
  }
  const uris = options.redirectUris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    throw new OauthClientError(
      'bad_redirect',
      `redirect_uris must hold 1 to ${MAX_REDIRECT_URIS} addresses`,
    );
  }
  for (const uri of uris) {
    const problem = redirectUriProblem(uri);
    if (problem !== null) throw new OauthClientError('bad_redirect', problem);
  }
  const redirectUris = [...new Set(uris as string[])];
  return db.transaction((): OauthClient => {
    purgeUnusedClients(db, now);
    const recent = db
      .prepare('SELECT COUNT(*) AS n FROM oauth_client WHERE created_at > ?')
      .get(new Date(now.getTime() - HOUR_MS).toISOString()) as { n: number };
    if (recent.n >= MAX_CLIENT_REGISTRATIONS_PER_HOUR) {
      throw new OauthClientError('too_many', 'too many registrations; try again later');
    }
    const id = db
      .prepare(
        `INSERT INTO oauth_client (client_id, tenant_id, name, redirect_uris, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        options.clientId,
        options.tenantId,
        name,
        JSON.stringify(redirectUris),
        now.toISOString(),
      ).lastInsertRowid as number;
    return {
      id,
      clientId: options.clientId,
      tenantId: options.tenantId,
      name,
      redirectUris,
    };
  })();
}

/**
 * The client registered under `clientId` **on this tenant's host** (`tenantId` null for a server
 * with no base domain), or null. A client registered at another tenant's address is unknown
 * here.
 */
export function getOauthClient(
  db: Database.Database,
  clientId: string,
  tenantId: number | null,
): OauthClient | null {
  const row = db
    .prepare('SELECT * FROM oauth_client WHERE client_id = ? AND tenant_id IS ?')
    .get(clientId, tenantId) as ClientRow | undefined;
  return row ? clientFromRow(row) : null;
}

/**
 * Stores a one-time authorization code for a person who consented.
 *
 * @param options.code - the code itself (`generateSessionToken`); only its hash is stored.
 * @param options.redirectUri - the address the request asked for, already matched against the
 *   client's; the exchange must name the same string.
 * @throws ConnectorTokenError `not_staff` when the person is staff of no tenant, or of another
 *   than the client's host's.
 */
export function createOauthCode(
  db: Database.Database,
  options: {
    readonly code: string;
    readonly client: OauthClient;
    readonly accountId: number;
    readonly redirectUri: string;
    readonly codeChallenge: string;
    readonly now?: Date;
  },
): void {
  const now = options.now ?? new Date();
  const membership = getTenantForAccount(db, options.accountId);
  if (
    !membership ||
    (options.client.tenantId !== null && membership.tenant.id !== options.client.tenantId)
  ) {
    throw new ConnectorTokenError('not_staff');
  }
  db.prepare(
    `INSERT INTO oauth_code
       (code_hash, client, account_id, tenant_id, redirect_uri, code_challenge, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hashSessionToken(options.code),
    options.client.id,
    options.accountId,
    membership.tenant.id,
    options.redirectUri,
    options.codeChallenge,
    new Date(now.getTime() + OAUTH_CODE_TTL_MS).toISOString(),
  );
}

/** Stores a fresh access token and refresh token for a connection, and moves its dates. */
function issueTokens(
  db: Database.Database,
  connection: { id: number; accountId: number; tenantId: number; name: string },
  tokens: { accessToken: string; refreshToken: string },
  now: Date,
): IssuedTokens {
  const at = now.toISOString();
  const refreshEnds = new Date(now.getTime() + OAUTH_REFRESH_TTL_MS).toISOString();
  // One access token per connection at a time: the last one ends when the next is issued.
  db.prepare(
    'UPDATE connector_token SET revoked_at = ? WHERE connection_id = ? AND revoked_at IS NULL',
  ).run(at, connection.id);
  db.prepare(
    `INSERT INTO connector_token
       (account_id, tenant_id, token_hash, label, created_at, expires_at, connection_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    connection.accountId,
    connection.tenantId,
    hashSessionToken(tokens.accessToken),
    connection.name,
    at,
    new Date(now.getTime() + OAUTH_ACCESS_TTL_MS).toISOString(),
    connection.id,
  );
  db.prepare(
    'INSERT INTO oauth_refresh (token_hash, connection_id, expires_at) VALUES (?, ?, ?)',
  ).run(hashSessionToken(tokens.refreshToken), connection.id, refreshEnds);
  db.prepare(
    'UPDATE oauth_connection SET last_used_at = ?, expires_at = ? WHERE id = ?',
  ).run(at, refreshEnds, connection.id);
  return { expiresIn: OAUTH_ACCESS_TTL_MS / 1000 };
}

const LIVE_CONNECTION = 'revoked_at IS NULL AND expires_at > @now';

/**
 * Exchanges an authorization code for a connection and its first tokens, in one transaction.
 * The code is spent by any try, right or wrong. A code presented a second time ends the
 * connection its first use made.
 *
 * A new connection ends the person's earlier one from the same client (a reconnect), and the
 * oldest when they would hold more than `MAX_CONNECTIONS`.
 *
 * @param options.clientId - the client the request names; must be the code's.
 * @param options.hostTenantId - the tenant of the host asked; must be the client's.
 * @param options.redirectUri - must be the exact string the code was issued for.
 * @param options.verifier - the PKCE verifier behind the code's challenge.
 * @param options.accessToken - the tokens to issue (`generateSessionToken`), stored as hashes.
 * @returns null for every refusal: unknown, spent or ended code, another client, host or address, a
 *   wrong verifier, or a person no longer staff of the code's tenant.
 */
export function exchangeOauthCode(
  db: Database.Database,
  options: {
    readonly code: string;
    readonly clientId: string;
    /** The tenant of the host the request came to (null with no base domain): the client's. */
    readonly hostTenantId: number | null;
    readonly redirectUri: unknown;
    readonly verifier: unknown;
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly now?: Date;
  },
): IssuedTokens | null {
  const now = options.now ?? new Date();
  const at = now.toISOString();
  return db.transaction((): IssuedTokens | null => {
    // Old codes and refresh tokens are of no use to anyone; a used refresh token is kept until
    // it would have ended, because presenting it again must still end its connection.
    db.prepare('DELETE FROM oauth_code WHERE expires_at < ?').run(
      new Date(now.getTime() - 24 * HOUR_MS).toISOString(),
    );
    db.prepare('DELETE FROM oauth_refresh WHERE expires_at < ?').run(at);
    const code = db
      .prepare(
        `SELECT k.id, k.account_id, k.tenant_id, k.redirect_uri, k.code_challenge, k.expires_at,
                k.used_at, k.connection_id, c.id AS client, c.client_id, c.name,
                c.tenant_id AS client_tenant
           FROM oauth_code k JOIN oauth_client c ON c.id = k.client
          WHERE k.code_hash = ?`,
      )
      .get(hashSessionToken(options.code)) as
      | {
          id: number;
          account_id: number;
          tenant_id: number;
          redirect_uri: string;
          code_challenge: string;
          expires_at: string;
          used_at: string | null;
          connection_id: number | null;
          client: number;
          client_id: string;
          name: string;
          client_tenant: number | null;
        }
      | undefined;
    if (!code) return null;
    if (code.used_at !== null) {
      if (code.connection_id !== null) {
        endConnection(db, code.connection_id, 'reuse', SYSTEM_ACTOR, now);
      }
      return null;
    }
    db.prepare('UPDATE oauth_code SET used_at = ? WHERE id = ?').run(at, code.id);
    if (
      code.expires_at <= at ||
      code.client_id !== options.clientId ||
      // A client is one tenant's host's: its code is exchanged there and nowhere else.
      code.client_tenant !== options.hostTenantId ||
      code.redirect_uri !== options.redirectUri ||
      !pkceMatches(options.verifier, code.code_challenge)
    ) {
      return null;
    }
    const membership = getTenantForAccount(db, code.account_id);
    const account = getAccountById(db, code.account_id);
    if (!account || !membership || membership.tenant.id !== code.tenant_id) return null;
    const actor: AuditActor = {
      actor: { kind: 'account', id: account.id },
      label: account.email,
    };
    const earlier = db
      .prepare(
        `SELECT id, client FROM oauth_connection
          WHERE account_id = @a AND ${LIVE_CONNECTION} ORDER BY id`,
      )
      .all({ a: account.id, now: at }) as { id: number; client: number }[];
    const kept = earlier.filter((c) => c.client !== code.client);
    for (const c of earlier) {
      if (c.client === code.client) endConnection(db, c.id, 'replaced', actor, now);
    }
    for (const c of kept.slice(0, Math.max(0, kept.length - (MAX_CONNECTIONS - 1)))) {
      endConnection(db, c.id, 'replaced', actor, now);
    }
    const connectionId = db
      .prepare(
        `INSERT INTO oauth_connection
           (account_id, tenant_id, client, created_at, last_used_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(account.id, code.tenant_id, code.client, at, at, at).lastInsertRowid as number;
    db.prepare('UPDATE oauth_code SET connection_id = ? WHERE id = ?').run(
      connectionId,
      code.id,
    );
    appendPlatformEvent(db, {
      actor,
      action: 'connector.connected',
      tenantId: code.tenant_id,
      subjectType: 'account',
      subjectId: String(account.id),
      detail: { connection_id: connectionId, client: code.client },
    });
    return issueTokens(
      db,
      {
        id: connectionId,
        accountId: account.id,
        tenantId: code.tenant_id,
        name: code.name,
      },
      options,
      now,
    );
  })();
}

/**
 * Exchanges a refresh token for a new access token and a new refresh token (rotation), in one
 * transaction. The old refresh token is spent; presenting a spent one ends the connection.
 *
 * @returns null for every refusal: unknown, spent or ended token, another client or host, a connection
 *   that ended, or a person no longer staff of its tenant.
 */
export function refreshOauthConnection(
  db: Database.Database,
  options: {
    readonly refreshToken: string;
    readonly clientId: string;
    /** The tenant of the host the request came to (null with no base domain): the client's. */
    readonly hostTenantId: number | null;
    readonly accessToken: string;
    readonly newRefreshToken: string;
    readonly now?: Date;
  },
): IssuedTokens | null {
  const now = options.now ?? new Date();
  const at = now.toISOString();
  return db.transaction((): IssuedTokens | null => {
    const row = db
      .prepare(
        `SELECT r.id, r.expires_at, r.used_at, g.id AS connection, g.account_id, g.tenant_id,
                g.revoked_at, c.client_id, c.name, c.tenant_id AS client_tenant
           FROM oauth_refresh r
           JOIN oauth_connection g ON g.id = r.connection_id
           JOIN oauth_client c ON c.id = g.client
          WHERE r.token_hash = ?`,
      )
      .get(hashSessionToken(options.refreshToken)) as
      | {
          id: number;
          expires_at: string;
          used_at: string | null;
          connection: number;
          account_id: number;
          tenant_id: number;
          revoked_at: string | null;
          client_id: string;
          name: string;
          client_tenant: number | null;
        }
      | undefined;
    if (!row) return null;
    if (row.used_at !== null) {
      endConnection(db, row.connection, 'reuse', SYSTEM_ACTOR, now);
      return null;
    }
    if (
      row.revoked_at !== null ||
      row.expires_at <= at ||
      row.client_id !== options.clientId ||
      row.client_tenant !== options.hostTenantId
    ) {
      return null;
    }
    const membership = getTenantForAccount(db, row.account_id);
    if (!membership || membership.tenant.id !== row.tenant_id) return null;
    db.prepare('UPDATE oauth_refresh SET used_at = ? WHERE id = ?').run(at, row.id);
    return issueTokens(
      db,
      {
        id: row.connection,
        accountId: row.account_id,
        tenantId: row.tenant_id,
        name: row.name,
      },
      { accessToken: options.accessToken, refreshToken: options.newRefreshToken },
      now,
    );
  })();
}

/** The account's live connections (not ended, not lapsed), oldest first. */
export function listConnections(
  db: Database.Database,
  accountId: number,
  now: Date = new Date(),
): Connection[] {
  const rows = db
    .prepare(
      `SELECT g.id, c.name, g.created_at, g.last_used_at
         FROM oauth_connection g JOIN oauth_client c ON c.id = g.client
        WHERE g.account_id = @a AND g.revoked_at IS NULL AND g.expires_at > @now
        ORDER BY g.id`,
    )
    .all({ a: accountId, now: now.toISOString() }) as {
    id: number;
    name: string;
    created_at: string;
    last_used_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

/**
 * Ends one of the account's own connections and records `connector.disconnected`.
 *
 * @returns false when the account has no live connection with this id: someone else's, an
 *   unknown one and one already ended are the same answer, so a route can make them one 404.
 */
export function revokeConnection(
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
        'SELECT id FROM oauth_connection WHERE id = ? AND account_id = ? AND revoked_at IS NULL',
      )
      .get(options.id, options.accountId);
    if (!row) return false;
    endConnection(db, options.id, 'person', options.actor, now);
    return true;
  })();
}
