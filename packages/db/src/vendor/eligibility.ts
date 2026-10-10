/**
 * The roster read against a job (backlog #128, vendor-spec.md's #156 note):
 * which vendors fit it and which do not, with the reasons. The rule is
 * `vendor-core`'s `exclusionReasons`; this only loads each vendor's profile
 * and capacity for it, and, for a project that is work for a portal client
 * with a pool (`client-pools.ts`), whether each is in that pool. A read, not a write, so there is no event and no
 * actor, and it filters nothing: every vendor is in the answer.
 */

import {
  exclusionReasons,
  type EligibilityJob,
  type ExclusionReason,
} from '@cat-tool/vendor-core';
import type Database from 'better-sqlite3';

import { getCapacity } from './capacity.js';
import { getClientPool } from './client-pools.js';
import { getProfile, listVendors } from './vendors.js';

export interface VendorFit {
  readonly vendorId: number;
  readonly accountId: number;
  readonly displayName: string | null;
  /** Empty when the vendor fits. */
  readonly reasons: readonly ExclusionReason[];
}

/** Every vendor on the roster, in roster order, each with the reasons they do not fit `job`. */
export function assessRoster(
  db: Database.Database,
  job: EligibilityJob,
  options: {
    /** The portal client the project is work for, if it is for one (`getPortalClient`). */
    readonly portalClientId?: number | null;
  } = {},
): VendorFit[] {
  // A client with no pool approves nobody and so restricts nobody.
  const pool =
    options.portalClientId == null ? [] : getClientPool(db, options.portalClientId);
  return listVendors(db).map((v) => {
    const profile = getProfile(db, v.id)!;
    return {
      vendorId: v.id,
      accountId: v.accountId,
      displayName: v.displayName,
      reasons: exclusionReasons(
        {
          languages: profile.languages,
          specialties: profile.specialties,
          capacity: getCapacity(db, v.id)?.status ?? null,
          inClientPool: pool.length === 0 ? null : pool.includes(v.id),
        },
        job,
      ),
    };
  });
}
