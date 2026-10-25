/**
 * A sign-in with a provider while it is in flight (backlog #214, `planning/sso-spec.md` D4): the
 * rows `sso_attempt` holds between the person leaving a tenant's host and coming back to it.
 *
 * Three steps, three callers. The tenant's host starts an attempt ({@link createSsoAttempt}). The
 * callback host finds it again by the `state` the provider returns, once ({@link claimSsoCallback}),
 * and after verifying the token files the identity and a one-minute hand-off code against it
 * ({@link completeSsoCallback}). The tenant's host redeems the code ({@link redeemSsoHandoff}) and
 * only then is anything signed in or linked, so the callback host holds no authority of its own.
 *
 * Every secret is kept only as its hash except the nonce and the PKCE verifier, which the token
 * exchange has to send back and which live for minutes.
 */

import {
  hashSessionToken,
  type SsoIdentity,
  type SsoProvider,
  type SsoPurpose,
} from '@cat-tool/core';
import type Database from 'better-sqlite3';

/** How long a person has to sign in at the provider and come back. */
export const SSO_ATTEMPT_TTL_MS = 5 * 60 * 1000;

/** How long the code the callback host hands the tenant's host stays good. */
export const SSO_HANDOFF_TTL_MS = 60 * 1000;

export interface NewSsoAttempt {
  /** The random `state` sent to the provider; stored only as its hash. */
  readonly state: string;
  /**
   * A secret the starting browser made and keeps (session storage), stored only as its hash and
   * shown again to redeem: a hand-off code presented by any other browser is refused.
   */
  readonly binding: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly provider: SsoProvider;
  readonly purpose: SsoPurpose;
  /** The tenant whose host started it; `null` when the server has no base domain. */
  readonly tenantId: number | null;
  /** For a link, the account that started it; `null` for a login. */
  readonly accountId: number | null;
  readonly now?: Date;
}

/** What the callback host needs to finish the exchange. */
export interface SsoAttempt {
  readonly id: number;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly provider: SsoProvider;
  readonly purpose: SsoPurpose;
  readonly tenantId: number | null;
  readonly accountId: number | null;
}

/**
 * Stores a new attempt, and sweeps the ones that can no longer be used so the table never grows.
 * An attempt whose callback was verified is kept until its hand-off expires too.
 *
 * @throws if a link names no account or a login names one (the table's CHECK).
 */
export function createSsoAttempt(db: Database.Database, attempt: NewSsoAttempt): void {
  const now = attempt.now ?? new Date();
  db.transaction(() => {
    db.prepare(
      `DELETE FROM sso_attempt
       WHERE expires_at < @now AND (handoff_expires_at IS NULL OR handoff_expires_at < @now)`,
    ).run({ now: now.toISOString() });
    db.prepare(
      `INSERT INTO sso_attempt
         (state_hash, binding_hash, nonce, code_verifier, provider, purpose, tenant_id, account_id,
          created_at, expires_at)
       VALUES (@state_hash, @binding_hash, @nonce, @code_verifier, @provider, @purpose, @tenant_id, @account_id,
          @created_at, @expires_at)`,
    ).run({
      state_hash: hashSessionToken(attempt.state),
      binding_hash: hashSessionToken(attempt.binding),
      nonce: attempt.nonce,
      code_verifier: attempt.codeVerifier,
      provider: attempt.provider,
      purpose: attempt.purpose,
      tenant_id: attempt.tenantId,
      account_id: attempt.accountId,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + SSO_ATTEMPT_TTL_MS).toISOString(),
    });
  })();
}

interface AttemptRow {
  id: number;
  nonce: string;
  code_verifier: string;
  provider: SsoProvider;
  purpose: SsoPurpose;
  tenant_id: number | null;
  account_id: number | null;
}

/**
 * Takes the attempt a returning `state` names, once: a second callback with the same state, an
 * expired one and a state nobody minted are all `null`. The claim is one conditional UPDATE, so two
 * callbacks racing for one state resolve to one winner.
 */
export function claimSsoCallback(
  db: Database.Database,
  state: string,
  now: Date = new Date(),
): SsoAttempt | null {
  const row = db
    .prepare(
      `UPDATE sso_attempt SET callback_at = @now
       WHERE state_hash = @state_hash AND callback_at IS NULL AND expires_at > @now
       RETURNING id, nonce, code_verifier, provider, purpose, tenant_id, account_id`,
    )
    .get({ state_hash: hashSessionToken(state), now: now.toISOString() }) as
    AttemptRow | undefined;
  return row
    ? {
        id: row.id,
        nonce: row.nonce,
        codeVerifier: row.code_verifier,
        provider: row.provider,
        purpose: row.purpose,
        tenantId: row.tenant_id,
        accountId: row.account_id,
      }
    : null;
}

/**
 * Files the verified identity and the hash of a one-minute hand-off code against a claimed attempt.
 * The code itself goes to the person's browser and nowhere else.
 */
export function completeSsoCallback(
  db: Database.Database,
  attemptId: number,
  identity: SsoIdentity,
  handoffCode: string,
  now: Date = new Date(),
): void {
  db.prepare(
    `UPDATE sso_attempt
     SET handoff_hash = @hash, handoff_expires_at = @expires, issuer = @issuer, subject = @subject
     WHERE id = @id AND callback_at IS NOT NULL AND handoff_hash IS NULL`,
  ).run({
    id: attemptId,
    hash: hashSessionToken(handoffCode),
    expires: new Date(now.getTime() + SSO_HANDOFF_TTL_MS).toISOString(),
    issuer: identity.issuer,
    subject: identity.subject,
  });
}

export interface RedeemOptions {
  /** The tenant of the host the code is being redeemed on; `null` when that host is no tenant's. */
  readonly tenantId: number | null;
  readonly purpose: SsoPurpose;
  /** For a link, the account the redeeming session belongs to; `null` for a login. */
  readonly accountId: number | null;
  /** The secret the starting browser made; see {@link NewSsoAttempt.binding}. */
  readonly binding: string;
  readonly now?: Date;
}

/**
 * The identity a hand-off code stands for, or `null`. The row is deleted by the same statement that
 * reads it, so a code works once, and **a code that fails a check is spent too**: a wrong host, a
 * wrong purpose or a wrong account never gets a second try. The checks are what keep a session
 * on its own tenant's host (D4): the tenant must be the one the attempt started on, the purpose
 * the one it was for, and a link only for the account that began it.
 */
export function redeemSsoHandoff(
  db: Database.Database,
  code: string,
  options: RedeemOptions,
): SsoIdentity | null {
  const now = (options.now ?? new Date()).toISOString();
  const row = db
    .prepare(
      `DELETE FROM sso_attempt
       WHERE handoff_hash = @hash
       RETURNING provider, purpose, tenant_id, account_id, binding_hash, issuer, subject,
                 handoff_expires_at`,
    )
    .get({ hash: hashSessionToken(code) }) as
    | {
        provider: SsoProvider;
        purpose: SsoPurpose;
        tenant_id: number | null;
        account_id: number | null;
        binding_hash: string;
        issuer: string;
        subject: string;
        handoff_expires_at: string;
      }
    | undefined;
  if (
    !row ||
    row.handoff_expires_at <= now ||
    row.tenant_id !== options.tenantId ||
    row.purpose !== options.purpose ||
    row.account_id !== options.accountId ||
    row.binding_hash !== hashSessionToken(options.binding)
  ) {
    return null;
  }
  return {
    provider: row.provider,
    issuer: row.issuer,
    subject: row.subject,
    directory: null,
    hostedDomain: null,
  };
}
