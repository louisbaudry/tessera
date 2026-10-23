/**
 * A tenant admin's invitation to join its staff (backlog #206, `planning/tenant-spec.md`
 * D5, §6). The same shape as a vendor's (`invitations.ts`, backlog #111) and a table of
 * its own, `staff_invitation`: a link that makes a vendor and a link that makes staff
 * must never be one row with a flag, because the one that attaches to the wrong tenant,
 * or in the wrong role, is the failure the schema is built to rule out. The tenant and
 * the role are fixed at invitation and frozen by trigger; acceptance reads them from the
 * row, never from the request.
 *
 * The token is a random 256-bit secret kept only as its SHA-256 hash. A link that is
 * unknown, used, withdrawn or expired is one identical `InvitationUnusableError`; an
 * address that already has an account is refused at acceptance (`EmailTakenError`,
 * the link stays pending) because a person is staff of one tenant (O1), and refusing
 * only then keeps the form from asking which addresses exist.
 *
 * Every write records its `audit_event` in the same transaction, with no address in the
 * hashed `detail` (erasure can only reach `actor_label`).
 */

import {
  generateSessionToken,
  hashSessionToken,
  isTenantRole,
  type AuditActor,
  type TenantRole,
} from '@cat-tool/core';
import {
  INVITATION_TTL_MS,
  invitationStatus,
  normalizeInviteEmail,
  type InvitationStatus,
} from '@cat-tool/vendor-core';
import type Database from 'better-sqlite3';

import { appendPlatformEvent } from './audit-write.js';
import { createAccount, getAccountByEmail, type Account } from './accounts.js';
import { EmailTakenError, InvitationUnusableError } from './invitations.js';

export interface StaffInvitation {
  readonly id: number;
  /** The tenant whose staff the invitee joins: fixed when the link is made. */
  readonly tenantId: number;
  /** The admin who sent it, and so vouched for the new account. */
  readonly invitedBy: number;
  readonly email: string;
  readonly role: TenantRole;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly acceptedAt: string | null;
  readonly acceptedAccountId: number | null;
  readonly revokedAt: string | null;
  readonly status: InvitationStatus;
}

interface Row {
  id: number;
  tenant_id: number;
  invited_by: number;
  role: string;
  email: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_account_id: number | null;
  revoked_at: string | null;
}

function fromRow(row: Row, now: Date): StaffInvitation {
  if (!isTenantRole(row.role)) {
    // The CHECK makes this unreachable; failing loudly beats a role nobody declared.
    throw new StaffInvitationError(`staff invitation has an unknown role "${row.role}"`);
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    invitedBy: row.invited_by,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    acceptedAccountId: row.accepted_account_id,
    revokedAt: row.revoked_at,
    status: invitationStatus(
      {
        acceptedAt: row.accepted_at,
        revokedAt: row.revoked_at,
        expiresAt: row.expires_at,
      },
      now,
    ),
  };
}

/**
 * A refused staff-invitation write: a bad address or role, an inviter who is not staff
 * of the tenant, or an invitation that is not this tenant's, is missing or is no longer
 * pending. The last three read the same on purpose.
 */
export class StaffInvitationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaffInvitationError';
  }
}

const NO_SUCH = 'no such staff invitation on this tenant';

const hashToken = (token: string): string => hashSessionToken(token);

const rowById = (db: Database.Database, id: number): Row =>
  db.prepare('SELECT * FROM staff_invitation WHERE id = ?').get(id) as Row;

export interface CreateStaffInvitationOptions {
  readonly tenantId: number;
  /** The staff account inviting; must belong to `tenantId`. */
  readonly invitedBy: number;
  /** As typed; normalised here (trimmed, lower-cased). */
  readonly email: string;
  readonly role: TenantRole;
  /** The admin, from their session: required (audit-spec.md decision 3). */
  readonly actor: AuditActor;
  readonly now?: Date;
}

/**
 * Invites an address to a tenant's staff. Returns the one-time `token` **once**: only
 * its hash is kept, so a lost link is replaced by inviting again, which withdraws the
 * earlier pending link for the same address (logged as revoked, `superseded`). Which
 * staff role may invite is the server's rule (`tenantRoleAllows(role, 'staff')`); here
 * the inviter need only be staff of the tenant.
 *
 * @throws {StaffInvitationError} for a bad address or role, or an inviter who is not
 *   staff of `tenantId` (a vendor never is).
 */
export function createStaffInvitation(
  db: Database.Database,
  options: CreateStaffInvitationOptions,
): { invitation: StaffInvitation; token: string } {
  const now = options.now ?? new Date();
  const email = normalizeInviteEmail(options.email);
  if (email === null) throw new StaffInvitationError('that is not an email address');
  if (!isTenantRole(options.role)) throw new StaffInvitationError('unknown role');
  const token = generateSessionToken();
  return db
    .transaction((): { invitation: StaffInvitation; token: string } => {
      const member = db
        .prepare('SELECT 1 FROM tenant_membership WHERE tenant_id = ? AND account_id = ?')
        .get(options.tenantId, options.invitedBy);
      if (!member) {
        throw new StaffInvitationError('only staff of a tenant can invite to its staff');
      }
      const pending = db
        .prepare(
          `SELECT id FROM staff_invitation
            WHERE tenant_id = ? AND email = ? AND accepted_at IS NULL
              AND revoked_at IS NULL AND expires_at > ?`,
        )
        .all(options.tenantId, email, now.toISOString()) as Array<{ id: number }>;
      for (const old of pending)
        withdraw(db, options.tenantId, old.id, now, options.actor, { superseded: true });
      const info = db
        .prepare(
          `INSERT INTO staff_invitation
             (tenant_id, invited_by, role, email, token_hash, created_at, expires_at)
           VALUES (@tenant, @by, @role, @email, @hash, @at, @exp)`,
        )
        .run({
          tenant: options.tenantId,
          by: options.invitedBy,
          role: options.role,
          email,
          hash: hashToken(token),
          at: now.toISOString(),
          exp: new Date(now.getTime() + INVITATION_TTL_MS).toISOString(),
        });
      const id = info.lastInsertRowid as number;
      appendPlatformEvent(db, {
        actor: options.actor,
        action: 'invitation.created',
        tenantId: options.tenantId,
        subjectType: 'staff_invitation',
        subjectId: String(id),
        detail: null,
      });
      return { invitation: fromRow(rowById(db, id), now), token };
    })
    .immediate();
}

/** The tenant's staff invitations, newest first, each with its derived status. */
export function listStaffInvitations(
  db: Database.Database,
  tenantId: number,
  now: Date = new Date(),
): StaffInvitation[] {
  return (
    db
      .prepare('SELECT * FROM staff_invitation WHERE tenant_id = ? ORDER BY id DESC')
      .all(tenantId) as Row[]
  ).map((row) => fromRow(row, now));
}

function withdraw(
  db: Database.Database,
  tenantId: number,
  id: number,
  now: Date,
  actor: AuditActor,
  detail: { readonly superseded: true } | null,
): void {
  const changed = db
    .prepare(
      `UPDATE staff_invitation SET revoked_at = ?
        WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
    )
    .run(now.toISOString(), id).changes;
  if (changed !== 1) throw new StaffInvitationError(NO_SUCH);
  appendPlatformEvent(db, {
    actor,
    action: 'invitation.revoked',
    tenantId,
    subjectType: 'staff_invitation',
    subjectId: String(id),
    detail,
  });
}

export interface RevokeStaffInvitationOptions {
  readonly tenantId: number;
  readonly id: number;
  readonly actor: AuditActor;
  readonly now?: Date;
}

/**
 * Withdraws a pending invitation. Another tenant's, a missing one and one already used
 * or withdrawn are one `StaffInvitationError`, so an id says nothing about who owns it.
 * An expired one is withdrawn like any other: its link is already dead, and the record
 * then says the admin closed it.
 */
export function revokeStaffInvitation(
  db: Database.Database,
  options: RevokeStaffInvitationOptions,
): StaffInvitation {
  const now = options.now ?? new Date();
  return db
    .transaction((): StaffInvitation => {
      const row = db
        .prepare('SELECT * FROM staff_invitation WHERE id = ? AND tenant_id = ?')
        .get(options.id, options.tenantId) as Row | undefined;
      if (!row) throw new StaffInvitationError(NO_SUCH);
      withdraw(db, row.tenant_id, row.id, now, options.actor, null);
      return fromRow(rowById(db, row.id), now);
    })
    .immediate();
}

/**
 * What the holder of a link may see before choosing a password: the address it was
 * made for. `null` for any link that cannot be used, whatever the reason. Neither the
 * tenant nor the role is shown: they are the admin's business until the link is used.
 */
export function openStaffInvitation(
  db: Database.Database,
  token: string,
  now: Date = new Date(),
): { email: string } | null {
  const row = db
    .prepare('SELECT * FROM staff_invitation WHERE token_hash = ?')
    .get(hashToken(token)) as Row | undefined;
  if (!row) return null;
  const invitation = fromRow(row, now);
  return invitation.status === 'pending' ? { email: invitation.email } : null;
}

export interface AcceptStaffInvitationOptions {
  readonly token: string;
  /** From `hashPassword`: never a raw password. */
  readonly passwordHash: string;
  readonly now?: Date;
}

/**
 * Uses a link: creates an `owner` account that is staff of the inviting tenant, in the
 * invited role, and marks the invitation used, in one transaction, so a link makes at
 * most one account and founds no tenant. The account's creation and its membership are
 * attributed to the admin, who vouched for it; the acceptance to the new account itself.
 *
 * @throws {InvitationUnusableError} for a link that is unknown, used, withdrawn or
 *   expired: one answer for all four.
 * @throws {EmailTakenError} if the address already has an account; the link stays pending.
 */
export function acceptStaffInvitation(
  db: Database.Database,
  options: AcceptStaffInvitationOptions,
): { account: Account; invitation: StaffInvitation } {
  const now = options.now ?? new Date();
  return db
    .transaction((): { account: Account; invitation: StaffInvitation } => {
      const row = db
        .prepare('SELECT * FROM staff_invitation WHERE token_hash = ?')
        .get(hashToken(options.token)) as Row | undefined;
      if (!row || fromRow(row, now).status !== 'pending')
        throw new InvitationUnusableError();
      if (getAccountByEmail(db, row.email)) throw new EmailTakenError();
      const invitation = fromRow(row, now);
      const account = createAccount(db, {
        email: row.email,
        passwordHash: options.passwordHash,
        actor: { actor: { kind: 'account', id: row.invited_by }, label: null },
        joinTenant: { tenantId: row.tenant_id, role: invitation.role },
      });
      const changed = db
        .prepare(
          `UPDATE staff_invitation SET accepted_at = ?, accepted_account_id = ?
            WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
        )
        .run(now.toISOString(), account.id, row.id).changes;
      if (changed !== 1) throw new InvitationUnusableError();
      appendPlatformEvent(db, {
        actor: { actor: { kind: 'account', id: account.id }, label: account.email },
        action: 'invitation.accepted',
        tenantId: row.tenant_id,
        subjectType: 'staff_invitation',
        subjectId: String(row.id),
        detail: { tenant_id: row.tenant_id, account_id: account.id },
      });
      return { account, invitation: fromRow(rowById(db, row.id), now) };
    })
    .immediate();
}
