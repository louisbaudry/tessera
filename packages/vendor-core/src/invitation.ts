/**
 * An owner's invitation to become a vendor (backlog #111; `vendor-spec.md` §3, the
 * #111 note): how long a link lives, what state it is in, which address it may
 * name and which password it may set. Pure: rows' timestamps in, a state out.
 * Storing the hashed token and creating the account is `db`'s.
 */

/** A link works for a week: long enough to reach a vendor, short enough to be forgotten. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const INVITATION_STATUSES = ['pending', 'accepted', 'revoked', 'expired'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export interface InvitationTimes {
  /** ISO timestamp; null while the link has not been used. */
  readonly acceptedAt: string | null;
  readonly revokedAt: string | null;
  readonly expiresAt: string;
}

/**
 * The state is derived from the timestamps, never stored, so it cannot disagree
 * with them. An act outranks the clock: a link that was used and has since passed
 * its date is still `accepted`, and one the owner withdrew is `revoked` however
 * old it is. Only a link nobody acted on can be `expired`, and it is
 * `pending` up to and not including its expiry instant.
 */
export function invitationStatus(
  times: InvitationTimes,
  now: Date = new Date(),
): InvitationStatus {
  if (times.acceptedAt !== null) return 'accepted';
  if (times.revokedAt !== null) return 'revoked';
  return now.toISOString() >= times.expiresAt ? 'expired' : 'pending';
}

const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * The address as the account will carry it: trimmed and lower-cased, or null if it
 * cannot be one. Lower-cased because `account.email` is compared as written at
 * login, so two spellings of one address would be two accounts. Deliberately
 * loose beyond that: the only proof an address is real is the person who
 * received the link.
 */
export function normalizeInviteEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

export const MIN_PASSWORD_LENGTH = 10;
/** scrypt does not cap a password, but the request body should not be a megabyte of one. */
export const MAX_PASSWORD_LENGTH = 200;

/** Why a password cannot be set, or null. Length only: the operator script has no rule at all. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `a password is at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `a password is at most ${MAX_PASSWORD_LENGTH} characters`;
  }
  return null;
}
