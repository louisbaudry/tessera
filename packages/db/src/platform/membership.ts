/**
 * Which tenants' rosters an account is on (backlog #52a, vendor-spec.md's #52a
 * note; keyed on the tenant since backlog #205): a derived index of the tenants'
 * `.ctv` files, kept so a vendor can find the tenants to read their feed from. The roster decides who is a vendor; a row
 * here that the roster does not back shows its account nothing.
 */

import type Database from 'better-sqlite3';

/** Records that `accountId` is on `tenantId`'s roster. Idempotent; true when a row was added. */
export function addRosterMembership(
  db: Database.Database,
  options: { tenantId: number; accountId: number; now?: Date },
): boolean {
  const at = (options.now ?? new Date()).toISOString();
  return (
    db
      .prepare(
        // ON CONFLICT, not OR IGNORE: that would swallow a CHECK or foreign-key
        // violation too, and report an invalid row as "already there".
        `INSERT INTO roster_membership (tenant_id, account_id, added_at)
         VALUES (?, ?, ?)
         ON CONFLICT (tenant_id, account_id) DO NOTHING`,
      )
      .run(options.tenantId, options.accountId, at).changes === 1
  );
}

/**
 * Whether an account belongs on `tenantId`'s host (`planning/tenant-spec.md` D14): staff of that
 * tenant, or a vendor on its roster. The one definition the gate, the login and the invitation
 * routes all ask, so no route decides it for itself. A vendor never has a tenant membership and
 * staff never have a roster row (both triggers), so the two cases cannot overlap.
 */
export function accountBelongsToTenant(
  db: Database.Database,
  accountId: number,
  tenantId: number,
): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM tenant_membership WHERE account_id = @a AND tenant_id = @t
         UNION ALL
         SELECT 1 FROM roster_membership WHERE account_id = @a AND tenant_id = @t`,
      )
      .get({ a: accountId, t: tenantId }) !== undefined
  );
}

/** The tenants whose rosters an account is on, by tenant id. */
export function listRosterTenants(db: Database.Database, accountId: number): number[] {
  return (
    db
      .prepare(
        'SELECT tenant_id FROM roster_membership WHERE account_id = ? ORDER BY tenant_id',
      )
      .all(accountId) as Array<{ tenant_id: number }>
  ).map((r) => r.tenant_id);
}
