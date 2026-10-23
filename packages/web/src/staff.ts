/**
 * What the staff screen decides (backlog #210, `planning/tenant-spec.md` D5, §6),
 * kept out of the component: the link an admin passes on, how a role reads, and
 * which controls a row may have. Pure, so it is proved in node. Whether an action is
 * allowed is the server's (`tenantFor`, the last-admin triggers); the screen only
 * greys out what it already knows would be refused, and says why.
 */
import type { TenantRole } from '@cat-tool/core';

import { inviteProblem } from './invitations.js';
import { formatRoute } from './route.js';

/**
 * The link to hand a new colleague: this page's own address with the token in the `#`
 * fragment, which no server, access log or `Referer` header ever sees. Its own route
 * (`#/join/`), because a staff link and a vendor link make different accounts.
 */
export function staffInviteLink(
  location: { origin: string; pathname: string },
  token: string,
): string {
  return `${location.origin}${location.pathname}${formatRoute({ screen: 'join', token })}`;
}

/** A `Record` over the union, so a role added to `core` fails this typecheck until it is named here. */
export const STAFF_ROLE_LABEL: Record<TenantRole, string> = {
  admin: 'Admin',
  pm: 'Project manager',
};

export const STAFF_ROLE_HELP: Record<TenantRole, string> = {
  admin: 'Everything, including staff, engine consent and webhooks.',
  pm: 'Projects, memories, glossaries, roster, assignments and payables.',
};

export const STAFF_ROLES = Object.keys(STAFF_ROLE_LABEL) as TenantRole[];

/** Why the invite form cannot be sent yet, or null. The server checks the address too. */
export const staffInviteProblem = inviteProblem;

export interface StaffRow {
  readonly accountId: number;
  readonly role: TenantRole;
}

export interface MemberControls {
  /** May this row's role be lowered, and may the person be removed. */
  readonly canDemote: boolean;
  readonly canRemove: boolean;
  /** Why a control is off, in the words the screen shows beside it; null when none is. */
  readonly why: string | null;
}

export const LAST_ADMIN_WHY = 'The only admin: make someone else an admin first.';

/**
 * What a row may do. A tenant keeps at least one admin, so the sole admin can be neither
 * demoted nor removed (the schema refuses it too); everyone else can be either. A pm can
 * always go: there is always an admin to answer for the tenant.
 */
export function memberControls(
  staff: readonly StaffRow[],
  member: StaffRow,
): MemberControls {
  const admins = staff.filter((s) => s.role === 'admin').length;
  const sole = member.role === 'admin' && admins <= 1;
  return { canDemote: !sole, canRemove: !sole, why: sole ? LAST_ADMIN_WHY : null };
}

/** The role a row would change to when its select is moved, never the one it already has. */
export const otherRoles = (role: TenantRole): TenantRole[] =>
  STAFF_ROLES.filter((r) => r !== role);
