/**
 * The identity link (backlog #214, `planning/sso-spec.md` D2, D3, D9): which provider identity
 * opens which account. A sign-in is matched on `(provider, issuer, subject)` and never on an
 * email, and this file never stores or logs one: a link row holds a provider's opaque subject
 * and the audit detail names the provider only.
 *
 * Linking is something a person does for their own account, behind proof of who they are
 * another way (spec §3); this file makes the link and refuses what would break the rules: one
 * identity opening two accounts, and an account left with no way in.
 */

import {
  hasPassword,
  type AuditActor,
  type SsoIdentity,
  type SsoProvider,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';

import {
  createAccountSession,
  getAccountById,
  tenantOfAccount,
  type Account,
} from './accounts.js';
import { appendPlatformEvent } from './audit-write.js';

/** What an account's owner may see of a link: never the subject or the issuer. */
export interface AccountIdentity {
  readonly id: number;
  readonly provider: SsoProvider;
  readonly linkedAt: string;
  readonly lastLoginAt: string | null;
}

/** The identity already opens an account (this one or another): a person never opens two. */
export class IdentityTakenError extends Error {
  constructor() {
    super('that identity is already linked to an account');
    this.name = 'IdentityTakenError';
  }
}

/** No such link on this account. Another account's link is the same answer. */
export class NoSuchIdentityError extends Error {
  constructor() {
    super('no such linked identity');
    this.name = 'NoSuchIdentityError';
  }
}

/** Unlinking would leave the account with neither a password nor another identity. */
export class LastWayInError extends Error {
  constructor() {
    super('that is the only way into this account');
    this.name = 'LastWayInError';
  }
}

export interface IdentityWriteOptions {
  readonly actor: AuditActor;
  /** The tenant the event is about; omitted, the account's own (none for a vendor). */
  readonly tenantId?: number | null;
  readonly now?: Date;
}

type IdentityKey = Pick<SsoIdentity, 'provider' | 'issuer' | 'subject'>;

interface IdentityRow {
  id: number;
  account_id: number;
  provider: SsoProvider;
  linked_at: string;
  last_login_at: string | null;
}

const publicRow = (row: IdentityRow): AccountIdentity => ({
  id: row.id,
  provider: row.provider,
  linkedAt: row.linked_at,
  lastLoginAt: row.last_login_at,
});

/** The account an identity opens, or `null`. */
export function findAccountByIdentity(
  db: Database.Database,
  identity: IdentityKey,
): Account | null {
  const row = db
    .prepare(
      `SELECT account_id FROM account_identity
       WHERE provider = ? AND issuer = ? AND subject = ?`,
    )
    .get(identity.provider, identity.issuer, identity.subject) as
    { account_id: number } | undefined;
  return row ? getAccountById(db, row.account_id) : null;
}

/** An account's linked identities, oldest first. */
export function listIdentities(
  db: Database.Database,
  accountId: number,
): AccountIdentity[] {
  return (
    db
      .prepare(
        `SELECT id, account_id, provider, linked_at, last_login_at
         FROM account_identity WHERE account_id = ? ORDER BY id`,
      )
      .all(accountId) as IdentityRow[]
  ).map(publicRow);
}

/**
 * Ties an identity to an account and records `account.sso_linked`, in one transaction. Linking
 * what the account already holds changes and logs nothing.
 *
 * @throws IdentityTakenError if the identity opens a different account.
 */
export function linkIdentity(
  db: Database.Database,
  accountId: number,
  identity: IdentityKey,
  options: IdentityWriteOptions,
): AccountIdentity {
  return db.transaction((): AccountIdentity => {
    const held = db
      .prepare(
        `SELECT id, account_id, provider, linked_at, last_login_at FROM account_identity
         WHERE provider = ? AND issuer = ? AND subject = ?`,
      )
      .get(identity.provider, identity.issuer, identity.subject) as
      IdentityRow | undefined;
    if (held) {
      if (held.account_id !== accountId) throw new IdentityTakenError();
      return publicRow(held);
    }
    const linkedAt = (options.now ?? new Date()).toISOString();
    const info = db
      .prepare(
        `INSERT INTO account_identity (account_id, provider, issuer, subject, linked_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(accountId, identity.provider, identity.issuer, identity.subject, linkedAt);
    appendPlatformEvent(db, {
      actor: options.actor,
      action: 'account.sso_linked',
      tenantId:
        options.tenantId === undefined
          ? tenantOfAccount(db, accountId)
          : options.tenantId,
      subjectType: 'account',
      subjectId: String(accountId),
      detail: { provider: identity.provider },
    });
    return {
      id: info.lastInsertRowid as number,
      provider: identity.provider,
      linkedAt,
      lastLoginAt: null,
    };
  })();
}

/**
 * Removes one of an account's links and records `account.sso_unlinked`.
 *
 * @throws NoSuchIdentityError if the link is not this account's (another's is the same answer).
 * @throws LastWayInError if it is the account's only way in: no password and no other link.
 */
export function unlinkIdentity(
  db: Database.Database,
  accountId: number,
  identityId: number,
  options: IdentityWriteOptions,
): void {
  db.transaction(() => {
    const row = db
      .prepare('SELECT provider FROM account_identity WHERE id = ? AND account_id = ?')
      .get(identityId, accountId) as { provider: SsoProvider } | undefined;
    const account = getAccountById(db, accountId);
    if (!row || !account) throw new NoSuchIdentityError();
    const others = db
      .prepare(
        'SELECT COUNT(*) AS n FROM account_identity WHERE account_id = ? AND id <> ?',
      )
      .get(accountId, identityId) as { n: number };
    if (!hasPassword(account.passwordHash) && others.n === 0) throw new LastWayInError();
    db.prepare('DELETE FROM account_identity WHERE id = ?').run(identityId);
    appendPlatformEvent(db, {
      actor: options.actor,
      action: 'account.sso_unlinked',
      tenantId:
        options.tenantId === undefined
          ? tenantOfAccount(db, accountId)
          : options.tenantId,
      subjectType: 'account',
      subjectId: String(accountId),
      detail: { provider: row.provider },
    });
  })();
}

/**
 * Starts a session for an account a provider signed in: the ordinary session, logged as
 * `auth.sso_login` naming the provider, with the identity's last use recorded in the same
 * transaction.
 */
export function createSsoSession(
  db: Database.Database,
  accountId: number,
  token: string,
  identity: IdentityKey,
  options: IdentityWriteOptions,
): { readonly expiresAt: string } {
  return db.transaction(() => {
    const now = options.now ?? new Date();
    db.prepare(
      `UPDATE account_identity SET last_login_at = ?
       WHERE account_id = ? AND provider = ? AND issuer = ? AND subject = ?`,
    ).run(
      now.toISOString(),
      accountId,
      identity.provider,
      identity.issuer,
      identity.subject,
    );
    return createAccountSession(db, accountId, token, {
      actor: options.actor,
      now,
      via: identity.provider,
      ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    });
  })();
}
