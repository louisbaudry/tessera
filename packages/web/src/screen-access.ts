/**
 * Which screens an account can open (issue #391, audit finding O4,
 * `planning/accessibility-audit.md` §5).
 *
 * The application shows a role's screens only to that role, and the server refuses the rest
 * anyway. But an address typed or kept from another account (`#/payments` by a member of
 * staff, `#/tms` by a vendor) rendered nothing at all: an empty page under a breadcrumb,
 * which tells nobody anything and a screen reader least of all. `screenAllowed` is the one
 * statement of who sees what, so the shell can say so instead of showing nothing. It hides
 * and explains; it is never the access check, which is the server's.
 */
import type { Route } from './route.js';

/** What the shell knows of the signed-in account. */
export interface Viewer {
  /** `owner` for tenant staff, `vendor` for a vendor. */
  readonly role: 'owner' | 'vendor';
  /** The staff role, or null for a vendor. */
  readonly staffRole: 'admin' | 'pm' | null;
}

/**
 * Whether `viewer` has a screen at `screen`.
 *
 * @param screen the screen a route names.
 * @param viewer the signed-in account's role and staff role.
 * @returns false when the shell would render nothing for this account.
 */
export function screenAllowed(screen: Route['screen'], viewer: Viewer): boolean {
  switch (screen) {
    case 'tms':
    case 'vendors':
    case 'payables':
      return viewer.role === 'owner';
    case 'staff':
    case 'audit':
      return viewer.staffRole === 'admin';
    case 'payments':
      return viewer.role === 'vendor';
    // Everyone has these; what they hold is the server's to decide.
    case 'projects':
    case 'project':
    case 'grid':
    case 'job':
    case 'account':
    case 'connect':
    case 'join':
    case 'invite':
      return true;
  }
}
