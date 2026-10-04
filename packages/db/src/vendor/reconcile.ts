/**
 * Reconciling project grants with assignment status (vendor-spec.md and its
 * #121 note). The accept and the review each change two files, the
 * assignment in the owner's `.ctv` and the grant in `platform.sqlite`, with
 * no transaction between them; this derives the grants that should exist from
 * the roster and fixes any difference.
 */

import type { AuditActor } from '@cat-tool/core';
import type { AssignmentStatus } from '@cat-tool/vendor-core';
import type Database from 'better-sqlite3';

import { addRosterMembership } from '../platform/membership.js';
import {
  AuthorizationError,
  grantProjectAuthorization,
  listAuthorizationsByOwner,
  revokeProjectAuthorization,
} from '../platform/authorization.js';
import { listAssignments } from './assignments.js';
import { getVendor, listVendors } from './vendors.js';

/** While an assignment is in one of these, its vendor works in the owner's project. */
const ACTIVE: readonly AssignmentStatus[] = ['accepted', 'in_progress', 'delivered'];

export interface GrantRef {
  readonly accountId: number;
  readonly project: string;
}

export interface ReconcileResult {
  /** Grants that should have existed and did not. */
  readonly granted: GrantRef[];
  /** Grants that should have ended and had not. */
  readonly revoked: GrantRef[];
  /** Grants it could not make, with why: one bad row does not stop the rest. */
  readonly skipped: Array<GrantRef & { reason: string }>;
}

export interface ReconcileOptions {
  /** The owner whose roster and projects these are. */
  readonly ownerId: number;
  /** Who is running it: required, as for every grant (audit-spec.md decision 3). */
  readonly actor: AuditActor;
}

const key = (r: GrantRef): string => `${r.accountId}\u0000${r.project}`;

/**
 * Makes the `assigned_translator` grants on an owner's projects match their
 * roster: a grant for every vendor with an active assignment, none for a
 * vendor whose assignments on the project have all ended. Governs only the
 * (account, project) pairs the roster has an assignment for, so a grant made
 * for another reason is left alone. Idempotent: a run that finds nothing wrong
 * writes nothing.
 */
export function reconcileAssignmentGrants(
  roster: Database.Database,
  platform: Database.Database,
  options: ReconcileOptions,
): ReconcileResult {
  const governed = new Set<string>();
  const wanted = new Map<string, GrantRef>();
  for (const a of listAssignments(roster)) {
    if (a.vendorId === null) continue; // a pool job nobody has claimed gives no one access
    const vendor = getVendor(roster, a.vendorId);
    if (!vendor) continue;
    const ref = { accountId: vendor.accountId, project: a.projectName };
    governed.add(key(ref));
    if (ACTIVE.includes(a.status)) wanted.set(key(ref), ref);
  }

  const result: ReconcileResult = { granted: [], revoked: [], skipped: [] };
  const held = new Set(
    listAuthorizationsByOwner(platform, options.ownerId)
      .filter((g) => g.scope === 'assigned_translator')
      .map((g) => key({ accountId: g.accountId, project: g.project.name })),
  );

  for (const ref of wanted.values()) {
    if (held.has(key(ref))) continue;
    try {
      grantProjectAuthorization(platform, {
        accountId: ref.accountId,
        project: { accountId: options.ownerId, name: ref.project },
        scope: 'assigned_translator',
        actor: options.actor,
      });
      result.granted.push(ref);
    } catch (err) {
      if (!(err instanceof AuthorizationError)) throw err;
      result.skipped.push({ ...ref, reason: err.message });
    }
  }

  for (const k of held) {
    if (wanted.has(k) || !governed.has(k)) continue;
    const [accountId, project] = k.split('\u0000') as [string, string];
    const ref = { accountId: Number(accountId), project };
    revokeProjectAuthorization(platform, {
      accountId: ref.accountId,
      project: { accountId: options.ownerId, name: ref.project },
      actor: options.actor,
    });
    result.revoked.push(ref);
  }
  return result;
}

/**
 * Makes the membership index match an owner's roster: a row for every vendor on
 * it (`roster_membership`, backlog #52a). Backfills rosters written before the
 * index existed, and mends one a failed step left short. Never removes a row:
 * a membership the roster does not back shows its account nothing, so a spare
 * row is harmless and a missing one hides a vendor's whole feed. Returns the
 * account ids it added.
 */
export function reconcileMemberships(
  roster: Database.Database,
  platform: Database.Database,
  ownerId: number,
): number[] {
  const added: number[] = [];
  for (const vendor of listVendors(roster)) {
    try {
      if (addRosterMembership(platform, { ownerId, accountId: vendor.accountId })) {
        added.push(vendor.accountId);
      }
    } catch {
      // An account that no longer exists (a foreign key): nothing to index.
    }
  }
  return added;
}
