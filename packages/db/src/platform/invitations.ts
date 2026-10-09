/**
 * An owner's invitation to become a vendor (backlog #111; `vendor-spec.md` §3, the
 * #111 note). The owner vouches for an address; the link they pass on lets its
 * holder set a password once, and that one step makes the account and puts it
 * on the owner's roster index. The roster file's own entry is the server's second
 * step (`server/src/invitations.ts`), a different file no transaction here covers.
 *
 * The token is a random 256-bit secret kept only as its SHA-256 hash, so this file
 * stores no way to set a password. A link that is unknown, used, withdrawn or expired
 * is one identical refusal (`InvitationUnusableError`): a stranger learns nothing about
 * which tokens were ever real. An address already holding an account is refused at
 * acceptance, never at invitation, so an owner cannot use this to ask which
 * addresses have accounts.
 *
 * Every write records its `audit_event` in the same transaction. The email is never
 * in the hashed `detail` (erasure can only reach `actor_label`); it lives in
 * `vendor_invitation` and, once accepted, in `account`.
 */

import { generateSessionToken, hashSessionToken, type AuditActor } from '@cat-tool/core';
import {
  INVITATION_TTL_MS,
  invitationStatus,
  normalizeInviteEmail,
  type InvitationStatus,
} from '@cat-tool/vendor-core';
import type Database from 'better-sqlite3';

import { appendAuditEvent } from '../audit/events.js';
import {
  createAccount,
  getAccountByEmail,
  getAccountById,
  type Account,
} from './accounts.js';
import { addRosterMembership } from './membership.js';

export interface Invitation {
  readonly id: number;
  readonly ownerId: number;
  readonly email: string;
  /** What the owner calls the invitee; becomes the roster entry's display name. */
  readonly displayName: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly acceptedAt: string | null;
  readonly acceptedAccountId: number | null;
  readonly revokedAt: string | null;
  readonly status: InvitationStatus;
}

interface Row {
  id: number;
  owner_id: number;
  email: string;
  display_name: string | null;
  token_hash: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_account_id: number | null;
  revoked_at: string | null;
}

const fromRow = (row: Row, now: Date): Invitation => ({
  id: row.id,
  ownerId: row.owner_id,
  email: row.email,
  displayName: row.display_name,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  acceptedAt: row.accepted_at,
  acceptedAccountId: row.accepted_account_id,
  revokedAt: row.revoked_at,
  status: invitationStatus(
    { acceptedAt: row.accepted_at, revokedAt: row.revoked_at, expiresAt: row.expires_at },
    now,
  ),
});

/** The request is not a valid invitation (a bad address, or an inviter who is not an owner). */
export class InvalidInvitationError extends Error {}
/** No such invitation on this owner's list: identical for another owner's and a missing one. */
export class NoSuchInvitationError extends Error {}
/** The invitation is no longer pending, so there is nothing to withdraw. */
export class InvitationNotPendingError extends Error {}
/** The link is unknown, used, withdrawn or expired: one answer for all four. */
export class InvitationUnusableError extends Error {
  constructor() {
    super('this invitation link is not valid');
  }
}
/** The signed-in account cannot join as a vendor: it is an owner's account (backlog #187). */
export class InvitationRoleError extends Error {
  constructor() {
    super('only a vendor account can join a roster');
  }
}
/** The invited address already has an account here; the invitee should sign in instead. */
export class EmailTakenError extends Error {
  constructor() {
    super('an account with this address already exists');
  }
}

const hashToken = (token: string): string => hashSessionToken(token);

function rowByToken(db: Database.Database, token: string): Row | undefined {
  return db
    .prepare('SELECT * FROM vendor_invitation WHERE token_hash = ?')
    .get(hashToken(token)) as Row | undefined;
}

/** Opens an owner-only action: the inviter must be an `owner` account. */
function requireOwner(db: Database.Database, ownerId: number): void {
  const owner = getAccountById(db, ownerId);
  if (!owner || owner.role !== 'owner') {
    throw new InvalidInvitationError('only an owner can invite a vendor');
  }
}

export interface CreateInvitationOptions {
  readonly ownerId: number;
  /** As typed; normalised here (trimmed, lower-cased). */
  readonly email: string;
  readonly displayName?: string | null;
  /** The owner, from their session: required (audit-spec.md decision 3). */
  readonly actor: AuditActor;
  readonly now?: Date;
}

/**
 * Invites an address. Returns the one-time `token` **once**: only its hash is kept,
 * so a lost link is replaced by inviting again, which withdraws the earlier pending
 * one for the same address (logged as revoked, `superseded`).
 */
export function createInvitation(
  db: Database.Database,
  options: CreateInvitationOptions,
): { invitation: Invitation; token: string } {
  const now = options.now ?? new Date();
  const email = normalizeInviteEmail(options.email);
  if (email === null) throw new InvalidInvitationError('that is not an email address');
  const displayName = cleanName(options.displayName);
  const token = generateSessionToken();
  return db
    .transaction((): { invitation: Invitation; token: string } => {
      requireOwner(db, options.ownerId);
      const pending = db
        .prepare(
          `SELECT * FROM vendor_invitation
            WHERE owner_id = ? AND email = ? AND accepted_at IS NULL
              AND revoked_at IS NULL AND expires_at > ?`,
        )
        .all(options.ownerId, email, now.toISOString()) as Row[];
      for (const old of pending) {
        withdraw(db, old.id, now, options.actor, { superseded: true });
      }
      const info = db
        .prepare(
          `INSERT INTO vendor_invitation
             (owner_id, email, display_name, token_hash, created_at, expires_at)
           VALUES (@owner, @email, @name, @hash, @at, @exp)`,
        )
        .run({
          owner: options.ownerId,
          email,
          name: displayName,
          hash: hashToken(token),
          at: now.toISOString(),
          exp: new Date(now.getTime() + INVITATION_TTL_MS).toISOString(),
        });
      const id = info.lastInsertRowid as number;
      appendAuditEvent(db, {
        actor: options.actor,
        action: 'invitation.created',
        subjectType: 'invitation',
        subjectId: String(id),
        detail: null,
      });
      const row = db
        .prepare('SELECT * FROM vendor_invitation WHERE id = ?')
        .get(id) as Row;
      return { invitation: fromRow(row, now), token };
    })
    .immediate();
}

const cleanName = (name: string | null | undefined): string | null => {
  const text = (name ?? '').trim();
  if (text === '') return null;
  if (text.length > 120)
    throw new InvalidInvitationError('a name is at most 120 characters');
  return text;
};

/** The owner's invitations, newest first, each with its derived status. */
export function listInvitations(
  db: Database.Database,
  ownerId: number,
  now: Date = new Date(),
): Invitation[] {
  return (
    db
      .prepare('SELECT * FROM vendor_invitation WHERE owner_id = ? ORDER BY id DESC')
      .all(ownerId) as Row[]
  ).map((r) => fromRow(r, now));
}

function withdraw(
  db: Database.Database,
  id: number,
  now: Date,
  actor: AuditActor,
  detail: { readonly superseded: true } | null,
): void {
  const changed = db
    .prepare(
      `UPDATE vendor_invitation SET revoked_at = ?
        WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
    )
    .run(now.toISOString(), id).changes;
  if (changed !== 1) throw new InvitationNotPendingError('the invitation is not pending');
  appendAuditEvent(db, {
    actor,
    action: 'invitation.revoked',
    subjectType: 'invitation',
    subjectId: String(id),
    detail,
  });
}

export interface RevokeInvitationOptions {
  readonly ownerId: number;
  readonly id: number;
  readonly actor: AuditActor;
  readonly now?: Date;
}

/**
 * Withdraws a pending invitation. One that is another owner's or does not exist is a
 * `NoSuchInvitationError`; one already used or withdrawn, a
 * `InvitationNotPendingError`. An expired one is withdrawn like any other: its link
 * is already dead, and the record then says the owner closed it.
 */
export function revokeInvitation(
  db: Database.Database,
  options: RevokeInvitationOptions,
): Invitation {
  const now = options.now ?? new Date();
  return db
    .transaction((): Invitation => {
      const row = db
        .prepare('SELECT * FROM vendor_invitation WHERE id = ? AND owner_id = ?')
        .get(options.id, options.ownerId) as Row | undefined;
      if (!row) throw new NoSuchInvitationError(`no invitation #${options.id}`);
      withdraw(db, row.id, now, options.actor, null);
      return fromRow(
        db.prepare('SELECT * FROM vendor_invitation WHERE id = ?').get(row.id) as Row,
        now,
      );
    })
    .immediate();
}

/**
 * What the holder of a link may see before choosing a password: the address it was
 * made for. `null` for any link that cannot be used, whatever the reason.
 */
export function openInvitation(
  db: Database.Database,
  token: string,
  now: Date = new Date(),
): { email: string } | null {
  const row = rowByToken(db, token);
  if (!row) return null;
  const invitation = fromRow(row, now);
  return invitation.status === 'pending' ? { email: invitation.email } : null;
}

export interface AcceptInvitationOptions {
  readonly token: string;
  /** From `hashPassword`: never a raw password. */
  readonly passwordHash: string;
  readonly now?: Date;
}

/**
 * Uses a link: creates the vendor account, records it on the owner's roster index and
 * marks the invitation used, in one transaction, so a link makes at most one account.
 * Throws `InvitationUnusableError` for a link that is unknown, used, withdrawn or
 * expired, and `EmailTakenError` if the address already has an account (the link then
 * stays pending). The account's creation is attributed to the owner, who vouched for
 * it; its acceptance to the new account itself, the one who actually did it.
 */
export function acceptInvitation(
  db: Database.Database,
  options: AcceptInvitationOptions,
): { account: Account; invitation: Invitation } {
  const now = options.now ?? new Date();
  return db
    .transaction((): { account: Account; invitation: Invitation } => {
      const row = rowByToken(db, options.token);
      if (!row || fromRow(row, now).status !== 'pending')
        throw new InvitationUnusableError();
      if (getAccountByEmail(db, row.email)) throw new EmailTakenError();
      const account = createAccount(db, {
        email: row.email,
        passwordHash: options.passwordHash,
        role: 'vendor',
        actor: { actor: { kind: 'account', id: row.owner_id }, label: null },
      });
      const changed = db
        .prepare(
          `UPDATE vendor_invitation SET accepted_at = ?, accepted_account_id = ?
            WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
        )
        .run(now.toISOString(), account.id, row.id).changes;
      if (changed !== 1) throw new InvitationUnusableError();
      addRosterMembership(db, { ownerId: row.owner_id, accountId: account.id, now });
      appendAuditEvent(db, {
        actor: { actor: { kind: 'account', id: account.id }, label: account.email },
        action: 'invitation.accepted',
        subjectType: 'invitation',
        subjectId: String(row.id),
        detail: { owner_id: row.owner_id, account_id: account.id },
      });
      return {
        account,
        invitation: fromRow(
          db.prepare('SELECT * FROM vendor_invitation WHERE id = ?').get(row.id) as Row,
          now,
        ),
      };
    })
    .immediate();
}

export interface JoinInvitationOptions {
  readonly token: string;
  /** The signed-in account that holds the link: its session is the proof of who it is. */
  readonly accountId: number;
  readonly now?: Date;
}

/**
 * Uses a link as an account that **already exists** (backlog #187, `vendor-spec.md`'s
 * #187 note): a vendor who works for one owner is invited by another. No account is
 * made; the signed-in vendor is put on the owner's roster index and the link is marked
 * used, in one transaction. The link alone never attaches anyone to an account: the
 * caller must be signed in, as the account whose address the owner invited. A link
 * made for another address, or one that cannot be used, is the same
 * `InvitationUnusableError` as ever, so a stranger holding a link learns nothing from
 * trying it on an account of theirs. An owner's account is refused
 * (`InvitationRoleError`): the roster decides who is a vendor, and an owner is not one.
 */
export function joinInvitation(
  db: Database.Database,
  options: JoinInvitationOptions,
): { account: Account; invitation: Invitation } {
  const now = options.now ?? new Date();
  return db
    .transaction((): { account: Account; invitation: Invitation } => {
      const row = rowByToken(db, options.token);
      if (!row || fromRow(row, now).status !== 'pending')
        throw new InvitationUnusableError();
      const account = getAccountById(db, options.accountId);
      if (!account || account.email !== row.email) throw new InvitationUnusableError();
      if (account.role !== 'vendor') throw new InvitationRoleError();
      const changed = db
        .prepare(
          `UPDATE vendor_invitation SET accepted_at = ?, accepted_account_id = ?
            WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
        )
        .run(now.toISOString(), account.id, row.id).changes;
      if (changed !== 1) throw new InvitationUnusableError();
      addRosterMembership(db, { ownerId: row.owner_id, accountId: account.id, now });
      appendAuditEvent(db, {
        actor: { actor: { kind: 'account', id: account.id }, label: account.email },
        action: 'invitation.accepted',
        subjectType: 'invitation',
        subjectId: String(row.id),
        detail: { owner_id: row.owner_id, account_id: account.id, existing: true },
      });
      return {
        account,
        invitation: fromRow(
          db.prepare('SELECT * FROM vendor_invitation WHERE id = ?').get(row.id) as Row,
          now,
        ),
      };
    })
    .immediate();
}

/** Accepted invitations of an owner, for the server to bring each roster file level with. */
export function listAcceptedInvitations(
  db: Database.Database,
  ownerId: number,
): Array<{ accountId: number; displayName: string | null }> {
  return db
    .prepare(
      `SELECT accepted_account_id AS accountId, display_name AS displayName
           FROM vendor_invitation
          WHERE owner_id = ? AND accepted_account_id IS NOT NULL ORDER BY id`,
    )
    .all(ownerId) as Array<{ accountId: number; displayName: string | null }>;
}
