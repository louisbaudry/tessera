/**
 * Which owners' rosters an account is on (backlog #52a, vendor-spec.md's #52a
 * note): a derived index of the owners' `.ctv` files, kept so a vendor can find
 * the owners to read their feed from. The roster decides who is a vendor; a row
 * here that the roster does not back shows its account nothing.
 */

import type Database from 'better-sqlite3';

/** Records that `accountId` is on `ownerId`'s roster. Idempotent; true when a row was added. */
export function addRosterMembership(
  db: Database.Database,
  options: { ownerId: number; accountId: number; now?: Date },
): boolean {
  const at = (options.now ?? new Date()).toISOString();
  return (
    db
      .prepare(
        // ON CONFLICT, not OR IGNORE: that would swallow a CHECK or foreign-key
        // violation too, and report an invalid row as "already there".
        `INSERT INTO roster_membership (owner_id, account_id, added_at)
         VALUES (?, ?, ?)
         ON CONFLICT (owner_id, account_id) DO NOTHING`,
      )
      .run(options.ownerId, options.accountId, at).changes === 1
  );
}

/** The owners whose rosters an account is on, by owner id. */
export function listRosterOwners(db: Database.Database, accountId: number): number[] {
  return (
    db
      .prepare(
        'SELECT owner_id FROM roster_membership WHERE account_id = ? ORDER BY owner_id',
      )
      .all(accountId) as Array<{ owner_id: number }>
  ).map((r) => r.owner_id);
}
