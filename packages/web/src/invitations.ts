/**
 * What the vendor-invitation screens decide (backlog #111; `vendor-spec.md` §3, the
 * #111 note), kept out of the components: the link an owner passes on, how an
 * invitation's state and expiry read, and the form's own checks. Pure, so it is proved
 * in node. Whether a link works, and the password rule, are the server's and
 * `vendor-core`'s; the form repeats only what a person can see.
 */
import {
  INVITATION_TTL_MS,
  normalizeInviteEmail,
  passwordProblem,
  type InvitationStatus,
} from '@cat-tool/vendor-core';

import { formatRoute } from './route.js';

/**
 * The link to hand a vendor: this page's own address with the token in the `#`
 * fragment. A fragment is never sent to a server, so no access log, proxy or
 * `Referer` header ever holds it.
 */
export function inviteLink(
  location: { origin: string; pathname: string },
  token: string,
): string {
  return `${location.origin}${location.pathname}${formatRoute({ screen: 'invite', token })}`;
}

export const INVITATION_STATUS_LABEL: Record<InvitationStatus, string> = {
  pending: 'Waiting',
  accepted: 'Joined',
  revoked: 'Withdrawn',
  expired: 'Expired',
};

/** The lifetime in days, for the sentence that tells an owner when a link stops working. */
export const INVITATION_TTL_DAYS = Math.round(INVITATION_TTL_MS / 86_400_000);

/** Why the invite form cannot be sent yet, or null. The server normalises the address too. */
export function inviteProblem(email: string): string | null {
  if (email.trim() === '') return 'Enter an email address.';
  return normalizeInviteEmail(email) === null ? 'That is not an email address.' : null;
}

/** Why the accept form cannot be sent yet, or null: both boxes agree, and the length rule. */
export function acceptProblem(password: string, repeat: string): string | null {
  const length = passwordProblem(password);
  if (length !== null) return `Your ${length}.`;
  return password === repeat ? null : 'The two passwords differ.';
}

/** Whether a row still has an action: only a link nobody has used can be withdrawn. */
export const canWithdraw = (status: InvitationStatus): boolean => status === 'pending';
