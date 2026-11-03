/**
 * A client contact signing in with Microsoft or Google (issue #342, `planning/sso-spec.md` D6, §2b):
 * the one-time link that ties a contact to its first identity, the portal's own sign-in attempts,
 * contact sessions, and the switch that turns a client's private link off.
 *
 * The rules, each kept here and nowhere else:
 *
 * - **A contact is linked by its link, never by an address** (D1, §2b). The link is the proof, as an
 *   invitation is; the provider only says which identity opens the contact from then on.
 * - **A sign-in in flight is a row**, found by the hash of its state, claimed once, and handed back as
 *   a one-minute code that is spent by any try (the platform's rules, D4).
 * - **A disabled contact opens nothing**, and disabling one ends its sessions.
 * - **The private link cannot be turned off while nobody else could get in**: the client needs an
 *   enabled contact with a linked identity first.
 */

import {
  hashSessionToken,
  SESSION_TTL_MS,
  type AuditActor,
  type PortalSsoPurpose,
  type SsoIdentity,
  type SsoProvider,
} from '@cat-tool/core';
import { INVITATION_TTL_MS } from '@cat-tool/vendor-core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';
import { getClient, type Client } from './clients.js';
import type { ClientContact } from './contacts.js';

/** How long a person has to sign in at the provider and come back. */
export const PORTAL_SSO_ATTEMPT_TTL_MS = 5 * 60 * 1000;
/** How long the code the callback hands back stays good. */
export const PORTAL_SSO_HANDOFF_TTL_MS = 60 * 1000;

/** The identity already opens another contact: one person, one contact per portal. */
export class ContactIdentityTakenError extends Error {
  constructor() {
    super('that Microsoft or Google account already opens another contact');
    this.name = 'ContactIdentityTakenError';
  }
}

/** Turning the link off would leave nobody able to open the client's orders. */
export class LinkSwitchError extends Error {
  constructor() {
    super(
      'a contact must have signed in with Microsoft or Google before the link can be turned off',
    );
    this.name = 'LinkSwitchError';
  }
}

interface ContactRow {
  id: number;
  client_id: number;
  email: string;
  created_at: string;
  disabled_at: string | null;
}

const contactOf = (row: ContactRow): ClientContact => ({
  id: row.id,
  clientId: row.client_id,
  email: row.email,
  createdAt: row.created_at,
  disabledAt: row.disabled_at,
});

type IdentityKey = Pick<SsoIdentity, 'provider' | 'issuer' | 'subject'>;

// --- the one-time sign-in link -------------------------------------------------------------------

/**
 * Mints a contact's one-time sign-in link, replacing any earlier one. The token is returned once and
 * stored only as its hash.
 *
 * @returns The token, or `null` if the client has no such contact or it is disabled.
 */
export function issueContactSigninLink(
  db: Database.Database,
  clientId: number,
  contactId: number,
  token: string,
  now: Date = new Date(),
): string | null {
  const contact = db
    .prepare(
      'SELECT id FROM client_contact WHERE id = ? AND client_id = ? AND disabled_at IS NULL',
    )
    .get(contactId, clientId);
  if (!contact) return null;
  db.prepare(
    `INSERT INTO client_contact_signin_link (contact_id, token_hash, created_at, expires_at)
     VALUES (@contact, @hash, @now, @expires)
     ON CONFLICT (contact_id) DO UPDATE SET
       token_hash = excluded.token_hash, created_at = excluded.created_at,
       expires_at = excluded.expires_at`,
  ).run({
    contact: contactId,
    hash: hashSessionToken(token),
    now: now.toISOString(),
    expires: new Date(now.getTime() + INVITATION_TTL_MS).toISOString(),
  });
  return token;
}

/** The enabled contact a live sign-in link names, or `null` for every link that cannot be used. */
export function openContactSigninLink(
  db: Database.Database,
  token: string,
  now: Date = new Date(),
): ClientContact | null {
  const row = db
    .prepare(
      `SELECT c.* FROM client_contact_signin_link l
       JOIN client_contact c ON c.id = l.contact_id
       WHERE l.token_hash = ? AND l.expires_at > ? AND c.disabled_at IS NULL`,
    )
    .get(hashSessionToken(token), now.toISOString()) as ContactRow | undefined;
  return row ? contactOf(row) : null;
}

/**
 * Ties an identity to the contact a sign-in link names and spends the link, in one transaction.
 *
 * @returns The contact, or `null` if the link cannot be used.
 * @throws {ContactIdentityTakenError} if the identity opens another contact; the link stays usable.
 */
export function linkContactIdentity(
  db: Database.Database,
  token: string,
  identity: IdentityKey,
  now: Date = new Date(),
): ClientContact | null {
  return db
    .transaction((): ClientContact | null => {
      const contact = openContactSigninLink(db, token, now);
      if (!contact) return null;
      const held = db
        .prepare(
          'SELECT contact_id FROM client_contact_identity WHERE provider = ? AND issuer = ? AND subject = ?',
        )
        .get(identity.provider, identity.issuer, identity.subject) as
        { contact_id: number } | undefined;
      if (held && held.contact_id !== contact.id) throw new ContactIdentityTakenError();
      if (!held) {
        db.prepare(
          `INSERT INTO client_contact_identity (contact_id, provider, issuer, subject, linked_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          contact.id,
          identity.provider,
          identity.issuer,
          identity.subject,
          now.toISOString(),
        );
      }
      db.prepare('DELETE FROM client_contact_signin_link WHERE contact_id = ?').run(
        contact.id,
      );
      return contact;
    })
    .immediate();
}

/** The enabled contact an identity opens, or `null`: a disabled contact is the same `null`. */
export function findContactByIdentity(
  db: Database.Database,
  identity: IdentityKey,
): ClientContact | null {
  const row = db
    .prepare(
      `SELECT c.* FROM client_contact_identity i JOIN client_contact c ON c.id = i.contact_id
       WHERE i.provider = ? AND i.issuer = ? AND i.subject = ? AND c.disabled_at IS NULL`,
    )
    .get(identity.provider, identity.issuer, identity.subject) as ContactRow | undefined;
  return row ? contactOf(row) : null;
}

// --- a sign-in in flight -------------------------------------------------------------------------

export interface NewPortalSsoAttempt {
  readonly state: string;
  readonly binding: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly provider: SsoProvider;
  readonly purpose: PortalSsoPurpose;
  readonly now?: Date;
}

export interface PortalSsoAttempt {
  readonly id: number;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly provider: SsoProvider;
  readonly purpose: PortalSsoPurpose;
}

/** Stores a new attempt and sweeps the ones that can no longer be used. */
export function createPortalSsoAttempt(
  db: Database.Database,
  attempt: NewPortalSsoAttempt,
): void {
  const now = attempt.now ?? new Date();
  db.transaction(() => {
    db.prepare(
      `DELETE FROM sso_attempt
       WHERE expires_at < @now AND (handoff_expires_at IS NULL OR handoff_expires_at < @now)`,
    ).run({ now: now.toISOString() });
    db.prepare(
      `INSERT INTO sso_attempt
         (state_hash, binding_hash, nonce, code_verifier, provider, purpose, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hashSessionToken(attempt.state),
      hashSessionToken(attempt.binding),
      attempt.nonce,
      attempt.codeVerifier,
      attempt.provider,
      attempt.purpose,
      now.toISOString(),
      new Date(now.getTime() + PORTAL_SSO_ATTEMPT_TTL_MS).toISOString(),
    );
  })();
}

/** Takes the attempt a returning state names, once; anything else is `null`. */
export function claimPortalSsoCallback(
  db: Database.Database,
  state: string,
  now: Date = new Date(),
): PortalSsoAttempt | null {
  const row = db
    .prepare(
      `UPDATE sso_attempt SET callback_at = @now
       WHERE state_hash = @hash AND callback_at IS NULL AND expires_at > @now
       RETURNING id, nonce, code_verifier, provider, purpose`,
    )
    .get({ hash: hashSessionToken(state), now: now.toISOString() }) as
    | {
        id: number;
        nonce: string;
        code_verifier: string;
        provider: SsoProvider;
        purpose: PortalSsoPurpose;
      }
    | undefined;
  return row
    ? {
        id: row.id,
        nonce: row.nonce,
        codeVerifier: row.code_verifier,
        provider: row.provider,
        purpose: row.purpose,
      }
    : null;
}

/** Files the verified identity and the hash of a one-minute hand-off code against a claimed attempt. */
export function completePortalSsoCallback(
  db: Database.Database,
  attemptId: number,
  identity: IdentityKey,
  handoffCode: string,
  now: Date = new Date(),
): void {
  db.prepare(
    `UPDATE sso_attempt SET handoff_hash = ?, handoff_expires_at = ?, issuer = ?, subject = ?
     WHERE id = ? AND callback_at IS NOT NULL AND handoff_hash IS NULL`,
  ).run(
    hashSessionToken(handoffCode),
    new Date(now.getTime() + PORTAL_SSO_HANDOFF_TTL_MS).toISOString(),
    identity.issuer,
    identity.subject,
    attemptId,
  );
}

/**
 * The identity a hand-off code stands for, or `null`. The row is deleted by the read, so a code works
 * once, and a code that fails a check (purpose, browser, time) is spent too.
 */
export function redeemPortalSsoHandoff(
  db: Database.Database,
  code: string,
  options: {
    readonly purpose: PortalSsoPurpose;
    readonly binding: string;
    readonly now?: Date;
  },
): IdentityKey | null {
  const now = (options.now ?? new Date()).toISOString();
  const row = db
    .prepare(
      `DELETE FROM sso_attempt WHERE handoff_hash = ?
       RETURNING provider, purpose, binding_hash, issuer, subject, handoff_expires_at`,
    )
    .get(hashSessionToken(code)) as
    | {
        provider: SsoProvider;
        purpose: PortalSsoPurpose;
        binding_hash: string;
        issuer: string;
        subject: string;
        handoff_expires_at: string;
      }
    | undefined;
  if (
    !row ||
    row.handoff_expires_at <= now ||
    row.purpose !== options.purpose ||
    row.binding_hash !== hashSessionToken(options.binding)
  ) {
    return null;
  }
  return { provider: row.provider, issuer: row.issuer, subject: row.subject };
}

// --- contact sessions ------------------------------------------------------------------------------

/**
 * Starts a contact's session and records `auth.contact_login` as the client (the portal's actor for
 * every client act), naming the contact's number and the provider and nothing personal.
 */
export function createContactSession(
  db: Database.Database,
  contact: ClientContact,
  token: string,
  provider: SsoProvider,
  now: Date = new Date(),
): { readonly expiresAt: string } {
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO client_contact_session (contact_id, token_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
    ).run(contact.id, hashSessionToken(token), now.toISOString(), expiresAt);
    db.prepare(
      `UPDATE client_contact_identity SET last_login_at = ?
       WHERE contact_id = ? AND provider = ?`,
    ).run(now.toISOString(), contact.id, provider);
    appendAuditEvent(db, {
      actor: { actor: { kind: 'client', id: contact.clientId }, label: null },
      action: 'auth.contact_login',
      subjectType: 'client',
      subjectId: String(contact.clientId),
      detail: { provider, contact: contact.id },
    });
  })();
  return { expiresAt };
}

/** Records a refused contact sign-in: a reason, never what the provider said. */
export function recordFailedContactLogin(
  db: Database.Database,
  actor: AuditActor,
  reason: string,
): void {
  appendAuditEvent(db, {
    actor,
    action: 'auth.contact_login_failed',
    subjectType: 'client',
    subjectId: null,
    detail: { reason },
  });
}

/** The client a live session of an enabled contact opens, or `null`. */
export function getClientByContactSession(
  db: Database.Database,
  token: string,
  now: Date = new Date(),
): Client | null {
  const row = db
    .prepare(
      `SELECT c.client_id FROM client_contact_session s JOIN client_contact c ON c.id = s.contact_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND c.disabled_at IS NULL`,
    )
    .get(hashSessionToken(token), now.toISOString()) as { client_id: number } | undefined;
  return row ? getClient(db, row.client_id) : null;
}

// --- the private-link switch -----------------------------------------------------------------------

/**
 * Turns a client's private link on or off.
 *
 * @returns The client as it now is, or `null` if there is no such client.
 * @throws {LinkSwitchError} turning it off while no enabled contact has a linked identity.
 */
export function setClientLinkEnabled(
  db: Database.Database,
  clientId: number,
  enabled: boolean,
): Client | null {
  return db
    .transaction((): Client | null => {
      if (!getClient(db, clientId)) return null;
      if (!enabled) {
        const reachable = db
          .prepare(
            `SELECT 1 FROM client_contact c JOIN client_contact_identity i ON i.contact_id = c.id
             WHERE c.client_id = ? AND c.disabled_at IS NULL LIMIT 1`,
          )
          .get(clientId);
        if (!reachable) throw new LinkSwitchError();
      }
      db.prepare('UPDATE client SET link_enabled = ? WHERE id = ?').run(
        enabled ? 1 : 0,
        clientId,
      );
      return getClient(db, clientId);
    })
    .immediate();
}
